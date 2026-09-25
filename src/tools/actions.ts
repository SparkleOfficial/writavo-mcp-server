import { z } from "zod";
import {
  ACTIONS,
  ACTION_AREAS,
  NEVER_ACTIONS,
  OPERATIONS,
  REFUSALS,
  type McpOperation,
  type McpParam,
  type NeverAction,
} from "../generated/operations.js";
import type { ToolContext } from "../core/context.js";
import { text, toolError, type ToolResult } from "../errors.js";
import { callOperation, type CallVia, type ToolArgs } from "./call.js";
import { zodFor } from "./schema.js";

/**
 * MCP-3, owner decision 5: SEARCH AND RUN.
 *
 * The everyday content operations are individual tools. Everything else an assistant may reach
 * (Site settings, the organisation, formats and prompts, the pipeline's configuration and content
 * plan, delivery, SEO, outreach, the team, billing, insights) is a row of the generated ACTIONS
 * catalog, reached through three tools:
 *
 *   search_writavo_actions  a few words in, the matching operations out, each with its input
 *                           schema, its scope, the runner to use, and whether it asks first, needs
 *                           approval or costs money; a request that matches something an agent
 *                           can NEVER do returns that entry and its dashboard link instead.
 *                           Plain keyword scoring over the catalog: no model, no network.
 *   read_writavo_action     one GET operationId and its arguments. Read only, and annotated so, so
 *                           a client may run it without asking; it refuses anything that writes.
 *   run_writavo_action      one operationId that CHANGES something, validated against that
 *                           operation's schema, then sent through the SAME call path as every
 *                           generated tool: the same confirmation step, the same 428 approval
 *                           reply, the same error guidance. It refuses GET operations, so a
 *                           client's "may write" permission never covers a read and vice versa.
 *
 * Both runners refuse anything that is not in the catalog, so they can never become a way
 * around the tool policy: a withheld operation (API keys, webhooks, the host's own key routes) is
 * refused with its documented reason, and an individual tool's operation is pointed at that tool.
 *
 * Runtime-agnostic like the rest of the core: no filesystem, no environment.
 */

/** The catalog a handler reads. A parameter so the smoke test can exercise a fixture catalog. */
export type ActionCatalog = readonly McpOperation[];

const RUN = "run_writavo_action";
const READ = "read_writavo_action";
const SEARCH = "search_writavo_actions";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The runner for an operation: reads through read_writavo_action, everything else through run. */
export const runnerFor = (operation: McpOperation): string => (operation.method === "GET" ? READ : RUN);

// ---------------------------------------------------------------------------------------------
// The compact input schema a search result carries
// ---------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

function oneLine(value: string, limit = 160): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const stop = cut.lastIndexOf(". ");
  return stop > 60 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}...`;
}

function propertySchema(param: McpParam): JsonSchema {
  const out: JsonSchema = { type: param.nullable ? [param.kind, "null"] : param.kind };
  if (param.enum?.length) out.enum = param.enum;
  if (param.format) out.format = param.format;
  if (param.kind === "array") {
    const items: JsonSchema = { type: param.itemKind ?? "string" };
    if (param.itemEnum?.length) items.enum = param.itemEnum;
    out.items = items;
  }
  if (param.description) out.description = oneLine(param.description);
  return out;
}

/**
 * The operation's arguments as a JSON Schema object: every path, query and body field flat, the
 * way run_writavo_action takes them in `arguments`. Deliberately as lossy as the tools' own
 * schemas (kind, enum, format, required, nullable): lengths and patterns are the API's to enforce.
 */
export function compactInputSchema(operation: McpOperation): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const param of operation.params) {
    properties[param.name] = propertySchema(param);
    if (param.required) required.push(param.name);
  }
  if (operation.ifMatch) {
    properties.if_match = {
      type: "string",
      description: "Optional. The ETag from your last read; the write is refused if the object changed since.",
    };
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** The strict validator run_writavo_action applies: the same fields, nothing else. */
function argumentsValidator(operation: McpOperation): z.ZodTypeAny {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const param of operation.params) shape[param.name] = zodFor(param);
  if (operation.ifMatch) shape.if_match = z.string().optional();
  return z.object(shape).strict();
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "my", "our", "me", "i", "we", "and", "or", "on", "in", "into", "at",
  "it", "is", "be", "are", "with", "this", "that", "these", "from", "by", "how", "do", "does", "can", "could",
  "please", "want", "would", "like", "some", "all", "any", "about", "up", "out", "writavo", "via", "using",
  "who", "what", "which", "where", "when", "why", "there", "someone", "somebody", "anyone", "anybody", "one",
]);

/** Words a person uses for the things the catalog names differently. Expanded both ways. */
const SYNONYMS: string[][] = [
  ["member", "user", "people", "person", "teammate", "colleague", "staff", "seat"],
  ["invite", "invitation", "add"],
  ["remove", "delete", "revoke", "disconnect", "drop"],
  ["update", "change", "edit", "set", "modify", "rename", "configure"],
  ["create", "add", "new", "make"],
  ["list", "show", "view", "read", "see", "get"],
  ["domain", "hostname", "dns", "subdomain", "url"],
  ["cap", "limit", "budget", "ceiling"],
  ["credit", "topup", "top", "refill", "autorefill"],
  ["balance", "summary"],
  ["rename", "name"],
  ["invoice", "bill", "receipt", "payment"],
  ["billing", "plan", "subscription", "pricing"],
  ["format", "blueprint", "template", "contenttype"],
  ["prompt", "instruction"],
  ["keyword", "rank", "ranking", "serp", "position"],
  ["backlink", "link", "referring"],
  ["competitor", "rival"],
  ["overview", "summary", "dashboard", "stats", "statistics", "metric", "analytics"],
  ["log", "audit", "history", "activity"],
  ["cost", "spend", "spending", "usage"],
  ["config", "configuration", "setting", "settings", "cadence", "schedule"],
  ["plan", "queue", "topic", "idea", "backlog"],
  ["publish", "live", "deploy", "launch"],
  ["hosted", "host", "hosting"],
  ["proxy", "reverse", "subdirectory", "subfolder"],
  ["cms", "wordpress", "webflow", "ghost", "shopify", "wix"],
  ["role", "permission", "access", "right"],
  ["brand", "branding", "logo", "colour", "color", "theme"],
  ["voice", "tone", "audience", "knowledge", "profile"],
  ["organisation", "organization", "org", "company", "workspace"],
  ["scan", "check", "refresh", "run"],
  ["mention", "llm", "chatgpt", "ai"],
  ["gap", "opportunity"],
];

/**
 * Verbs that say the person wants to CHANGE something. A query with none of them ("credit
 * balance", "competitors") is a question, so reads are nudged ahead of writes that match as well.
 */
const WRITE_VERBS = new Set(
  [
    "add", "create", "new", "make", "update", "change", "edit", "set", "modify", "rename", "configure", "remove",
    "delete", "revoke", "disconnect", "drop", "invite", "connect", "publish", "deploy", "launch", "run", "scan",
    "check", "refresh", "turn", "enable", "disable", "buy", "purchase", "start", "push", "reorder", "track",
    "untrack", "import", "acknowledge", "verify", "sync", "keep", "cancel", "reset", "override", "requeue",
    "rescan", "pull", "raise", "lower", "increase", "decrease", "move", "stop", "pause", "resume", "kick",
  ].map((w) => stem(w)),
);

function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ses|xes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  return word;
}

/** camelCase, snake_case, paths and prose alike, down to stemmed lower-case words. */
export function tokenize(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

const SYNONYM_OF = (() => {
  const map = new Map<string, Set<string>>();
  for (const group of SYNONYMS) {
    const stems = group.map(stem);
    for (const s of stems) {
      const set = map.get(s) ?? new Set<string>();
      for (const other of stems) if (other !== s) set.add(other);
      map.set(s, set);
    }
  }
  return map;
})();

interface Indexed {
  operation: McpOperation;
  fields: { weight: number; tokens: Set<string> }[];
}

function indexOf(catalog: ActionCatalog): Indexed[] {
  return catalog.map((operation) => ({
    operation,
    fields: [
      { weight: 3, tokens: new Set(tokenize(`${operation.operationId} ${operation.tool}`)) },
      { weight: 3, tokens: new Set(tokenize(operation.summary)) },
      { weight: 2, tokens: new Set(tokenize(`${operation.tag} ${operation.area}`)) },
      { weight: 2, tokens: new Set(tokenize(operation.path.replace(/\{[^}]+\}/g, " "))) },
      { weight: 1, tokens: new Set(tokenize(`${operation.brief} ${operation.consequence ?? ""}`)) },
    ],
  }));
}

/** How well one query word matches one field: exact, via a synonym, or as a prefix. */
function wordScore(word: string, tokens: Set<string>): number {
  if (tokens.has(word)) return 1;
  for (const syn of SYNONYM_OF.get(word) ?? []) if (tokens.has(syn)) return 0.7;
  if (word.length >= 4) {
    for (const t of tokens) {
      if (t.length >= 4 && (t.startsWith(word) || word.startsWith(t))) return 0.5;
    }
  }
  return 0;
}

export interface ActionMatch {
  operation: McpOperation;
  score: number;
}

/**
 * Rank the catalog against a query. Each query word scores the best field it matches (weighted:
 * the operationId and summary most, then the area and path, then the description), scaled by how
 * rare the word is across the catalog so "get" does not outvote "invoice". A result that matches
 * every query word is lifted above one that matches some.
 */
export function searchActions(
  query: string,
  opts: { area?: string; limit?: number } = {},
  catalog: ActionCatalog = ACTIONS,
): ActionMatch[] {
  const words = [...new Set(tokenize(query))];
  // Listing an area defaults to the whole area (up to 20); a search to the best 8.
  const limit = Math.max(1, Math.min(20, Math.trunc(opts.limit ?? (words.length === 0 ? 20 : 8))));
  const pool = indexOf(opts.area ? catalog.filter((a) => a.area === opts.area) : catalog);
  const exact = query.trim();

  if (words.length === 0) {
    // An area on its own lists that area, in catalog order.
    return opts.area ? pool.slice(0, limit).map((i) => ({ operation: i.operation, score: 0 })) : [];
  }

  // Rarity is counted over what an operation is ABOUT (its name, summary, area and path), not its
  // prose: nearly every description mentions "the Site", but few operations are about it.
  const n = Math.max(pool.length, 1);
  const idf = new Map<string, number>();
  for (const w of words) {
    const df = pool.filter((i) => i.fields.some((f) => f.weight >= 2 && wordScore(w, f.tokens) > 0)).length;
    idf.set(w, Math.log(1 + n / Math.max(df, 1)));
  }

  // Intent: a query with a verb of change favours writes ("track a keyword" means trackKeyword,
  // not the list); one without favours reads ("credit balance" is a question).
  const question = !words.some((w) => WRITE_VERBS.has(w));
  const scored: ActionMatch[] = [];
  pool.forEach((item) => {
    let score = 0;
    let matched = 0;
    for (const w of words) {
      // The best field decides; every other field that also mentions the word adds a little, so
      // an operation whose summary AND description are about it beats one that only names it.
      const hits = item.fields.map((f) => wordScore(w, f.tokens) * f.weight).sort((a, b) => b - a);
      const best = hits[0] ?? 0;
      const rest = hits.slice(1).reduce((sum, h) => sum + h, 0);
      if (best > 0) matched += 1;
      score += (best + 0.25 * rest) * (idf.get(w) ?? 1);
    }
    if (score <= 0) return;
    if (matched === words.length && words.length > 1) score *= 1.25;
    if (question === (item.operation.method === "GET")) score *= 1.3;
    if (item.operation.operationId === exact || item.operation.tool === exact) score += 100;
    scored.push({ operation: item.operation, score });
  });
  // Stable: equal scores keep catalog order, which groups an area's reads before its writes.
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// The NEVER list, searchable
// ---------------------------------------------------------------------------------------------

export interface NeverMatch {
  never: NeverAction;
  score: number;
}

/**
 * A NEVER entry matches only when the request has at least two words and EVERY one of them is
 * one of its keywords, exactly (after stemming; no synonyms, no prefixes). That is deliberately
 * strict, so an ordinary request that shares a word with an entry ("change a member's role",
 * "invoices", "wordpress") is never shadowed. When it does match, it outranks the operations: the
 * right answer to "add a card" is the link where a person does it, not the nearest billing
 * operation.
 */
export function searchNever(query: string, never: readonly NeverAction[] = NEVER_ACTIONS): NeverMatch[] {
  const words = [...new Set(tokenize(query))];
  if (words.length < 2) return [];
  const out: NeverMatch[] = [];
  for (const entry of never) {
    const keywords = new Set(tokenize(entry.keywords));
    if (words.every((w) => keywords.has(w))) out.push({ never: entry, score: words.length });
  }
  return out;
}

export type CatalogMatch = ({ kind: "action" } & ActionMatch) | ({ kind: "never" } & NeverMatch);

/** Actions and NEVER entries together, NEVER entries first. No NEVER entries inside an area. */
export function searchCatalog(
  query: string,
  opts: { area?: string; limit?: number } = {},
  catalog: ActionCatalog = ACTIONS,
  never: readonly NeverAction[] = NEVER_ACTIONS,
): CatalogMatch[] {
  const actions = searchActions(query, opts, catalog).map((m) => ({ kind: "action" as const, ...m }));
  if (opts.area) return actions;
  const nevers = searchNever(query, never).slice(0, 2).map((m) => ({ kind: "never" as const, ...m }));
  const limit = Math.max(1, Math.min(20, Math.trunc(opts.limit ?? 8)));
  return [...nevers, ...actions].slice(0, Math.max(limit, nevers.length));
}

/** A NEVER entry as a search result: no operation_id, and the step a person takes. */
export function describeNever(entry: NeverAction): Record<string, unknown> {
  return {
    never_through_an_agent: entry.what,
    why: entry.why,
    next_step: entry.next_step,
    tell_the_person: "This cannot be done through any tool. Give the person the next step exactly as written.",
  };
}

function approvalText(operation: McpOperation): string {
  if (!operation.approval) return "no";
  const base =
    operation.approvalMode === "switchable"
      ? `when the organisation requires approvals (${operation.approval})`
      : `always, for an AI assistant (${operation.approval})`;
  return operation.approvalWhen ? `${base}. ${operation.approvalWhen}` : base;
}

/** One search result, as the model reads it. */
export function describeMatch(operation: McpOperation): Record<string, unknown> {
  const scopes = [operation.scope, ...operation.alsoScopes].filter((s) => s && s !== "none");
  return {
    operation_id: operation.operationId,
    runner: runnerFor(operation),
    call: `${operation.method} ${operation.path}`,
    area: operation.area,
    summary: operation.summary,
    ...(operation.brief && operation.brief !== operation.summary ? { details: operation.brief } : {}),
    needs_scope: scopes.length ? scopes.join(" and ") : "none",
    asks_first: operation.confirm,
    needs_approval: approvalText(operation),
    spends: operation.spendsCredits ? "credits" : operation.spendsMoney ? "money" : "nothing",
    ...(operation.consequence ? { consequence: operation.consequence } : {}),
    input_schema: compactInputSchema(operation),
  };
}

const AREA_LIST = ACTION_AREAS.join(", ");

export const SEARCH_WRITAVO_ACTIONS = {
  name: SEARCH,
  description:
    "Find the Writavo operation for anything beyond everyday content: Site settings and the knowledge profile, the organisation, " +
    "article formats and AI prompts, the pipeline's configuration and content plan, delivery and domains, SEO, outreach, the team " +
    "and roles, billing, and insights and logs. Returns the best matches, each with its operation_id, a summary, the scope it needs, " +
    "whether it asks the user first, needs a person's approval or costs money, its input schema, and its runner: read_writavo_action " +
    "for a read, run_writavo_action for a change. A request for something an AI assistant can never do (agent settings, payment " +
    "details, plan changes, deleting the Site, and so on) returns that instead, with the dashboard link to give the person. " +
    "Read only: searching changes nothing and needs no key. " +
    `Areas: ${AREA_LIST}.`,
  inputSchema: {
    query: z
      .string()
      .max(200)
      .describe('What you want to do or read, in a few plain words: "invite a team member", "custom domain", "credit balance".'),
    area: (ACTION_AREAS.length > 0 ? z.enum(ACTION_AREAS as unknown as [string, ...string[]]) : z.string())
      .optional()
      .describe("Only search this area. With an empty query, lists the area."),
    limit: z.number().int().min(1).max(20).optional().describe("How many matches to return. Default 8, at most 20."),
  },
};

export function handleSearchActions(rawArgs: ToolArgs, catalog: ActionCatalog = ACTIONS): ToolResult {
  const args = rawArgs ?? {};
  const query = typeof args.query === "string" ? args.query : "";
  const area = typeof args.area === "string" && args.area.length > 0 ? args.area : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  if (catalog.length === 0) {
    return text("This version of the server has no actions in its catalog. Everything it can do is one of its individual tools.");
  }
  if (area && !catalog.some((a) => a.area === area)) {
    return toolError(`There are no actions in the area "${area}". Areas with actions: ${[...new Set(catalog.map((a) => a.area))].join(", ")}.`);
  }
  if (tokenize(query).length === 0 && !area) {
    return toolError(`Say what you are looking for in a few words, or pass an area to list it. Areas: ${[...new Set(catalog.map((a) => a.area))].join(", ")}.`);
  }

  const matches = searchCatalog(query, { area, limit }, catalog);
  if (matches.length === 0) {
    return text(
      [
        `No action matches "${query}"${area ? ` in ${area}` : ""}.`,
        "",
        `Try other words, or list an area with an empty query. Areas: ${[...new Set(catalog.map((a) => a.area))].join(", ")}.`,
        "Articles, categories, tags, authors, media and pipeline runs are individual tools, not actions. Some things are never available to an AI assistant: get_api_docs section tools lists them with the link a person uses instead.",
      ].join("\n"),
    );
  }

  return text(
    [
      `${matches.length} result${matches.length === 1 ? "" : "s"} for "${query}"${area ? ` in ${area}` : ""}, best first.`,
      "",
      // One compact match per line: still one JSON array, at well under half the characters of an
      // indented one, which matters when twenty schemas come back at once.
      `[\n${matches.map((m) => JSON.stringify(m.kind === "never" ? describeNever(m.never) : describeMatch(m.operation))).join(",\n")}\n]`,
      "",
      ...(matches[0]?.kind === "never"
        ? ["The first result is something no AI assistant can do through these tools. Tell the person its next_step; do not try an operation instead.", ""]
        : []),
      `To run one: its runner (${READ} for a read, ${RUN} for a change) with operation_id and arguments matching its input_schema. If asks_first is true, tell the user what it does and pass confirm: true only after they agree. If it needs approval, the first call returns a link for a person; after they approve, call again with the same operation_id and arguments plus approval_id.`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const OPERATION_ID = z.string().min(1).max(100).describe(`The operation_id of an action, exactly as ${SEARCH} returned it.`);
const ARGUMENTS = z
  .union([z.record(z.unknown()), z.string()])
  .optional()
  .describe("The operation's arguments as one object, matching its input_schema (path, query and body fields together). Omit when it takes none.");

export const READ_WRITAVO_ACTION = {
  name: READ,
  description:
    `Read something from the Writavo actions catalog: Site settings, the organisation, formats and prompts, the pipeline's ` +
    `configuration and content plan, delivery, SEO, outreach, the team, billing, insights and logs. Find the operation first with ` +
    `${SEARCH} (its runner is ${READ}), then pass its operation_id and arguments. Read only: it runs GET operations and nothing else, ` +
    `and changes nothing. For anything that changes something, use ${RUN}.`,
  inputSchema: {
    operation_id: OPERATION_ID,
    arguments: ARGUMENTS,
  },
};

export const RUN_WRITAVO_ACTION = {
  name: RUN,
  description:
    `Change something through the Writavo actions catalog: find the operation first with ${SEARCH} (its runner is ${RUN}), then pass ` +
    "its operation_id and arguments. The arguments are checked against that operation's input schema before anything is sent. " +
    "Operations that change the live site, delete something, change the team or cost money return a description instead of acting " +
    "until the user has agreed (confirm: true), and many also need a person's approval in the Writavo dashboard: the first call then " +
    `returns a link and an approval id, and nothing happens until they approve. Reads are not run here: use ${READ}. Only operations ` +
    "in the catalog run here; everyday content has its own tools.",
  inputSchema: {
    operation_id: OPERATION_ID,
    arguments: ARGUMENTS,
    approval_id: z
      .string()
      .uuid()
      .optional()
      .describe(
        "Only when a previous call returned an approval link and the user has since approved it: the approval id from that reply. Send exactly the same operation_id and arguments as that call.",
      ),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Set to true only after the user has explicitly agreed to this action. Calling without it returns a description of what would happen and changes nothing.",
      ),
  },
};

/** How the replies of an action call refer to it, and how the header labels it. */
function viaAction(operation: McpOperation, runner: string): CallVia {
  return {
    tool: runner,
    name: `${runner} (operation_id "${operation.operationId}")`,
    again: `${runner} again (operation_id "${operation.operationId}", the same arguments)`,
  };
}

/** The catalog row for an id, by operationId or its snake-case name. */
export function findAction(id: string, catalog: ActionCatalog = ACTIONS): McpOperation | undefined {
  return catalog.find((a) => a.operationId === id) ?? catalog.find((a) => a.tool === id);
}

function refuseUnknown(id: string, catalog: ActionCatalog, runner: string): ToolResult {
  const tool = OPERATIONS.find((o) => o.operationId === id || o.tool === id);
  if (tool) {
    return toolError(`${id} is not an action: it is the ${tool.tool} tool. Call ${tool.tool} directly. Nothing was done.`);
  }
  const refused = REFUSALS.find((r) => r.operationId === id);
  if (refused) {
    return toolError(`${id} (${refused.method} ${refused.path}) is not available to an AI assistant. ${refused.reason} Nothing was done.`);
  }
  const suggestions = searchActions(id, { limit: 3 }, catalog).map((m) => m.operation.operationId);
  return toolError(
    [
      `There is no action "${id}". ${runner} runs only operations from the actions catalog, exactly as ${SEARCH} names them. Nothing was done.`,
      suggestions.length ? `Did you mean: ${suggestions.join(", ")}?` : `Find the operation with ${SEARCH} first.`,
    ].join(" "),
  );
}

/** read_writavo_action: GET operations only. */
export function handleReadAction(ctx: ToolContext, rawArgs: ToolArgs, catalog: ActionCatalog = ACTIONS): Promise<ToolResult> {
  return runAction(ctx, rawArgs, catalog, READ);
}

/** run_writavo_action: every operation that is not a GET. */
export function handleRunAction(ctx: ToolContext, rawArgs: ToolArgs, catalog: ActionCatalog = ACTIONS): Promise<ToolResult> {
  return runAction(ctx, rawArgs, catalog, RUN);
}

async function runAction(ctx: ToolContext, rawArgs: ToolArgs, catalog: ActionCatalog, runner: string): Promise<ToolResult> {
  const args = rawArgs ?? {};
  const id = typeof args.operation_id === "string" ? args.operation_id.trim() : "";
  if (!id) return toolError(`${runner} needs operation_id. Find it with ${SEARCH}. Nothing was done.`);

  const operation = findAction(id, catalog);
  if (!operation) return refuseUnknown(id, catalog, runner);

  // The split is the point: a client that lets read_writavo_action run unasked (it is annotated
  // read only) must never reach a write through it, and run_writavo_action is not a way to read.
  const right = runnerFor(operation);
  if (right !== runner) {
    return toolError(
      runner === READ
        ? `${operation.operationId} changes something (${operation.method} ${operation.path}), and ${READ} only reads. Call ${RUN} with the same operation_id and arguments. Nothing was done.`
        : `${operation.operationId} is a read (GET ${operation.path}). Call ${READ} with the same operation_id and arguments. Nothing was done.`,
    );
  }

  // arguments: an object, or the same object as JSON text (some clients send nested objects so).
  let given: Record<string, unknown> = {};
  if (typeof args.arguments === "string") {
    const raw = args.arguments.trim();
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        given = parsed as Record<string, unknown>;
      } catch {
        return toolError(`${runner}: arguments must be a JSON object. Nothing was done.`);
      }
    }
  } else if (args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)) {
    given = { ...(args.arguments as Record<string, unknown>) };
  } else if (args.arguments !== undefined && args.arguments !== null) {
    return toolError(`${runner}: arguments must be an object. Nothing was done.`);
  }

  // confirm and approval_id belong at the top level; a model that tucks them into arguments means
  // the same thing, so they are lifted rather than refused (an operation never has fields by
  // those names: the generator asserts it). Wherever it comes from, an approval id must be a
  // UUID: it goes out as a header, and anything else is refused before it gets that far.
  let confirm = args.confirm === true;
  let approvalId: unknown = args.approval_id;
  if ("confirm" in given) {
    confirm = confirm || given.confirm === true;
    delete given.confirm;
  }
  if ("approval_id" in given) {
    if (approvalId === undefined || approvalId === null || approvalId === "") approvalId = given.approval_id;
    delete given.approval_id;
  }
  if (approvalId === null || approvalId === "") approvalId = undefined;
  if (approvalId !== undefined && (typeof approvalId !== "string" || !UUID.test(approvalId))) {
    return toolError(
      `${runner}: approval_id must be the approval id (a UUID) exactly as an earlier reply gave it. Nothing was done.`,
    );
  }

  const checked = argumentsValidator(operation).safeParse(given);
  if (!checked.success) {
    const problems = checked.error.issues.map((issue) => {
      const where = issue.path.length ? issue.path.join(".") : "arguments";
      return `- ${where}: ${issue.message}`;
    });
    return toolError(
      [
        `${operation.operationId} was not called: its arguments do not match its input schema. Nothing was done.`,
        "",
        ...problems,
        "",
        "The input schema:",
        JSON.stringify(compactInputSchema(operation), null, 2),
      ].join("\n"),
    );
  }

  const callArgs: ToolArgs = { ...(checked.data as Record<string, unknown>) };
  if (confirm) callArgs.confirm = true;
  if (typeof approvalId === "string" && operation.approval) callArgs.approval_id = approvalId.toLowerCase();

  return callOperation(ctx, operation, callArgs, viaAction(operation, runner));
}
