#!/usr/bin/env node
// gen-mcp-tools — compile openapi.yaml into the MCP server's tool surface (API-6 §1, §2).
//
// THE MISTAKE THIS EXISTS NOT TO REPEAT. The reference implementation's MCP server carries
// `mcp-server/src/data/api-docs.ts`, a hand-written 355-line copy of an API contract that already
// exists as a 571-line reference page in the same repo. Two hand-written copies of one contract
// drift, and those two have. So here the tool list, every tool's input schema, every tool
// description and the reference text the server serves are all COMPILED from openapi.yaml. A tool
// cannot describe an endpoint that does not exist, cannot accept a field the endpoint refuses, and
// cannot go missing when an endpoint is added.
//
//   node scripts/gen-mcp-tools.mjs           (pnpm mcp:gen)
//   node scripts/gen-mcp-tools.mjs --check   exit 1 if the committed output is stale
//
// Outputs, all under packages/mcp/src/generated/:
//   operations.ts   one entry per operation that becomes a tool, the ACTIONS catalog that
//                   search_writavo_actions / run_writavo_action serve (MCP-3 decision 5), and the
//                   documented refusals
//   errors.ts       the error catalog joined to scripts/error-guidance.mjs
//   reference.ts    the text `get_api_docs` and the MCP resources serve
//
// The policy and the compilation itself live in scripts/mcp-surface.mjs, because the /docs/mcp
// page is generated from the same function. This file is the part that writes to disk.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";
import { ACTION_TAGS, LOCAL_TOOLS, NEVER_ACTIONS, areaOf, buildMcpSurface } from "./mcp-surface.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The package sits at packages/mcp here and AT THE ROOT in the standalone
// SparkleOfficial/writavo-mcp-server repo, which vendors this script and openapi.yaml verbatim so
// it can build and --check without the monorepo. Resolve the output by layout so ONE generator
// serves both and the two copies stay byte-identical; a forked generator is precisely the drift
// this file exists to prevent, and CI asserts the vendored copies match (scripts/check-mcp-vendor.mjs).
const PKG_DIR = existsSync(join(ROOT, "packages", "mcp")) ? join(ROOT, "packages", "mcp") : ROOT;
const OUT_DIR = join(PKG_DIR, "src", "generated");
const CHECK = process.argv.includes("--check");

const spec = parse(readFileSync(join(ROOT, "openapi.yaml"), "utf8"));

// -- the calls the server makes for itself ------------------------------------------------------
// The key self-service routes (extend the key in use, revoke it on logout) are driven by the
// server's own sign-in lifecycle, never by a model. An assistant that could revoke the key it is
// running on, or keep a key alive indefinitely, is a tool nobody asked for. They are taken out of
// the specification the surface is compiled from and recorded as refusals with that reason, so
// they are accounted for like every other operation whatever tag the specification files them
// under. Matched by path prefix, so a later /auth/key/* route is withheld without an edit here.
const HOST_OWNED_PREFIX = "/auth/key/";
const HOST_OWNED_REASON =
  "Used by the MCP server itself, never by an assistant: the stdio server extends a signed-in key while it is in use and revokes it on logout, and the hosted server does the same when it refreshes a connection.";
const hostOwned = [];
const surfaceSpec = { ...spec, paths: {} };
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  if (!path.startsWith(HOST_OWNED_PREFIX)) {
    surfaceSpec.paths[path] = item;
    continue;
  }
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = item?.[method];
    if (!op) continue;
    hostOwned.push({
      operationId: String(op.operationId ?? ""),
      method: method.toUpperCase(),
      path,
      tag: String(op.tags?.[0] ?? ""),
      reason: HOST_OWNED_REASON,
    });
  }
}

const surface = buildMcpSurface(surfaceSpec);
const { sections, errorCatalog, baseUrl, problems } = surface;
const refusals = [...surface.refusals, ...hostOwned];

// -- approvals and annotations ------------------------------------------------------------------
// `x-writavo-approval: <action>` marks an operation the API may park behind a person's approval
// when an AI agent's key calls it (MCP-2). The tool then takes an optional approval_id, sent back
// as the Writavo-Approval header on the retry. Read straight from the specification, so a newly
// gated route grows the argument with no edit here, and a spec without the extension yields none.
const specOperation = new Map();
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = item?.[method];
    if (op?.operationId) specOperation.set(String(op.operationId), { path, method: method.toUpperCase(), op });
  }
}
const APPROVAL_ACTION = /^[a-z]+\.[a-z_]+$/;
const APPROVAL_KINDS = ["money", "team", "live", "destructive"];

// Whether the specification states "always" per operation (`x-writavo-approval-always: true`,
// MCP-3). When it does anywhere, its absence on a gated operation MEANS switchable; a spec that
// predates the extension falls back to the derivation in finish().
const SPEC_STATES_ALWAYS = [...specOperation.values()].some(({ op }) => op?.["x-writavo-approval-always"] !== undefined);

/**
 * Tool or action, the same row shape: the approval, whether the organisation's approvals switch can
 * waive it, when it is asked, and the annotations. Owner decision 6 (MCP-3): money and team
 * actions ALWAYS need a person's approval when an AI agent asks, whatever the switch says; the
 * switch relaxes only the rest (deleting, unpublishing, changes to the live site). The
 * specification says which is which with `x-writavo-approval-always`; without it, "always" is
 * derived as everything except an individual content tool that removes something.
 */
function finish(operation) {
  const op = specOperation.get(operation.operationId)?.op ?? {};
  const raw = op["x-writavo-approval"];
  let approval = null;
  if (raw !== undefined && raw !== null) {
    if (typeof raw === "string" && APPROVAL_ACTION.test(raw)) approval = raw;
    else problems.push(`${operation.method} ${operation.path}: x-writavo-approval must be an action like "article.delete", got ${JSON.stringify(raw)}`);
  }
  // Destructive means content is removed or taken off the web: every DELETE, and the verbs whose
  // gate says so (unpublish). Derived rather than listed, like the confirmation gate.
  const destructive =
    operation.method === "DELETE" ||
    /(^|[A-Z_])[uU]npublish/.test(operation.operationId) ||
    (approval !== null && /\.(delete|unpublish|remove|disconnect)$/.test(approval));

  let approvalMode = null;
  let approvalKind = null;
  let approvalWhen = null;
  const always = op["x-writavo-approval-always"];
  const kind = op["x-writavo-approval-kind"];
  const when = op["x-writavo-approval-when"];
  if (approval) {
    if (always !== undefined && typeof always !== "boolean") {
      problems.push(`${operation.method} ${operation.path}: x-writavo-approval-always must be true or false, got ${JSON.stringify(always)}`);
    }
    approvalMode =
      always === true
        ? "always"
        : always === false || SPEC_STATES_ALWAYS
          ? "switchable"
          : operation.surface === "tool" && /\.(delete|unpublish)$/.test(approval)
            ? "switchable"
            : "always";
    if (kind !== undefined) {
      if (APPROVAL_KINDS.includes(kind)) approvalKind = kind;
      else problems.push(`${operation.method} ${operation.path}: x-writavo-approval-kind must be one of ${APPROVAL_KINDS.join(", ")}, got ${JSON.stringify(kind)}`);
    }
    if (when !== undefined) {
      const sentence = typeof when === "string" ? when.replace(/\s+/g, " ").trim() : "";
      if (sentence) approvalWhen = sentence;
      else problems.push(`${operation.method} ${operation.path}: x-writavo-approval-when must be a sentence`);
    }
  } else {
    for (const [name, value] of [["x-writavo-approval-always", always], ["x-writavo-approval-kind", kind], ["x-writavo-approval-when", when]]) {
      if (value !== undefined) problems.push(`${operation.method} ${operation.path}: ${name} without x-writavo-approval`);
    }
  }

  const annotations = {
    title: operation.summary,
    readOnlyHint: operation.method === "GET",
    destructiveHint: destructive,
    idempotentHint: ["GET", "PUT", "PATCH", "DELETE"].includes(operation.method),
    // Every tool reaches one closed system, the customer's own Site, through one API.
    openWorldHint: false,
  };
  const retry =
    operation.surface === "tool"
      ? "call again with the same arguments plus approval_id"
      : "call run_writavo_action again with the same operation_id and arguments plus approval_id";
  const whenLine = approvalWhen ? ` ${approvalWhen.replace(/\.$/, "")}.` : "";
  const description = approval
    ? approvalMode === "always"
      ? `${operation.description} APPROVAL: when an AI assistant calls this it always needs a person's approval first: the first call returns a link for them instead of acting; after they approve, ${retry}.${whenLine}`
      : `${operation.description} APPROVAL: when the organisation requires it, the first call returns a link for a person to approve instead of acting; after they approve, ${retry}.${whenLine}`
    : operation.description;
  return { ...operation, description, approval, approvalMode, approvalKind, approvalWhen, annotations };
}

const operations = surface.operations.map(finish);
const actions = surface.actions.map(finish);

// The areas search_writavo_actions filters by: every MCP-3 tag, whether or not the specification
// has routes under it yet, then any other area an action lives in (the MCP-3 pipeline routes).
const actionAreas = [...new Set([...ACTION_TAGS.map(areaOf), ...actions.map((a) => a.area)])];

if (problems.length > 0) {
  console.error("openapi.yaml cannot be turned into an MCP tool surface:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const BANNER = (extraSource) =>
  [
    "// GENERATED FILE. Do not edit.",
    `//   source: openapi.yaml${extraSource ? ` + ${extraSource}` : ""}`,
    "//   regenerate: pnpm mcp:gen",
    "//",
    "// `pnpm docs:check` rule 12 re-runs the generator and diffs it against what is committed, so",
    "// a hand edit here fails CI rather than quietly becoming a second copy of the contract.",
    "",
  ].join("\n");

const json = (value) => JSON.stringify(value, null, 2);

const files = {
  "operations.ts": `${BANNER(null)}
/** Where a tool argument goes on the wire. */
export type ParamLocation = "path" | "query" | "body";

/** A tool argument, reduced to what building a schema and a request needs. */
export interface McpParam {
  name: string;
  in: ParamLocation;
  kind: "string" | "number" | "integer" | "boolean" | "array" | "object";
  itemKind?: "string" | "number" | "integer" | "boolean" | "object";
  itemEnum?: string[];
  enum?: string[];
  format?: string;
  required: boolean;
  nullable: boolean;
  explode: boolean;
  description: string;
}

/** Why a tool asks before it acts. Null means it does not need to. */
export type ConfirmReason = "spend" | "destructive" | "approval" | "public" | null;

/** MCP tool annotations, derived from the method and the specification's extensions. */
export interface McpAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/**
 * Whether an approval can be waived by the organisation's approvals switch. "always": an AI
 * agent's key needs a person's approval every time (MCP-3 decision 6: money and team actions,
 * \`x-writavo-approval-always\`). "switchable": only while the organisation requires approvals
 * (deleting, unpublishing, changes to the live site).
 */
export type ApprovalMode = "always" | "switchable";

export interface McpOperation {
  /** The MCP tool name. For an action, the snake-case name it is also known by. */
  tool: string;
  operationId: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** The path template, relative to the base URL. \`{id}\` segments are filled from params. */
  path: string;
  tag: string;
  /**
   * "tool": registered as its own MCP tool. "action": in the ACTIONS catalog, reached through
   * search_writavo_actions and run_writavo_action (MCP-3 decision 5).
   */
  surface: "tool" | "action";
  /** The catalog area, the tag in snake case: "site_settings", "seo", "team". */
  area: string;
  summary: string;
  /** The first paragraph of the specification's description, at most 240 characters. */
  brief: string;
  /** What the model reads when it chooses between tools. */
  description: string;
  scope: string;
  /** Further scopes the key must also carry (\`x-also-scopes\`). */
  alsoScopes: string[];
  entitlement: string;
  publishable: boolean;
  spendsCredits: boolean;
  /** Costs the organisation (or Writavo) money without spending credits (\`x-spends-money\`). */
  spendsMoney: boolean;
  /** The one sentence a person agrees to (\`x-agent-consequence\`), or null. */
  consequence: string | null;
  makesPublic: boolean;
  readOnly: boolean;
  confirm: boolean;
  confirmReason: ConfirmReason;
  /** The API requires an Idempotency-Key. The client generates one per call. */
  idempotency: boolean;
  /** The API accepts If-Match, so the tool takes an optional if_match argument. */
  ifMatch: boolean;
  /**
   * The approval action from \`x-writavo-approval\`, or null. When set, the API may answer an AI
   * agent's call with 428 and a link for a person, and the tool takes an optional approval_id.
   */
  approval: string | null;
  /** Null exactly when approval is null. */
  approvalMode: ApprovalMode | null;
  /** What kind of consequence the approval guards (\`x-writavo-approval-kind\`), or null. */
  approvalKind: "money" | "team" | "live" | "destructive" | null;
  /** When a conditional approval is asked (\`x-writavo-approval-when\`), or null for every call. */
  approvalWhen: string | null;
  annotations: McpAnnotations;
  params: McpParam[];
}

/** An operation deliberately not exposed to an assistant, and the reason shown when asked. */
export interface McpRefusal {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  reason: string;
}

export const API_BASE_URL = ${json(baseUrl)};
export const API_VERSION = ${json(String(spec.info?.version ?? ""))};

export const OPERATIONS: McpOperation[] = ${json(operations)};

export const REFUSALS: McpRefusal[] = ${json(refusals)};

/**
 * THE ACTIONS CATALOG (MCP-3 decision 5). Every operation an assistant may reach that is not an
 * individual tool: settings, delivery, SEO, outreach, the team, billing, insights, formats and
 * prompts, and the pipeline's configuration and content plan. search_writavo_actions ranks these;
 * run_writavo_action runs exactly these and nothing else.
 */
export const ACTIONS: McpOperation[] = ${json(actions)};

/** The areas search_writavo_actions accepts. */
export const ACTION_AREAS = ${json(actionAreas)} as const;

/** Something an AI agent can never do, and the next step a person takes instead. */
export interface NeverAction {
  what: string;
  why: string;
  next_step: string;
  /** What search_writavo_actions matches a request against. */
  keywords: string;
}

/**
 * The NEVER list (MCP-3 contract §9), searchable: search_writavo_actions returns an entry as a
 * result with no operation_id, so "add a card" answers with the dashboard link, not a near miss.
 */
export const NEVER_ACTIONS: NeverAction[] = ${json(NEVER_ACTIONS)};
`,

  "errors.ts": `${BANNER("scripts/error-guidance.mjs")}
export interface ErrorLink {
  label: string;
  url: string;
}

export interface ErrorEntry {
  code: string;
  http: string;
  /** What the code means. From the spec. */
  meaning: string;
  /** What to change. From scripts/error-guidance.mjs, the same source the docs page renders. */
  action: string;
  links: ErrorLink[];
}

export const ERROR_CATALOG: ErrorEntry[] = ${json(errorCatalog)};

export const ERRORS_BY_CODE: Record<string, ErrorEntry> = Object.fromEntries(
  ERROR_CATALOG.map((entry) => [entry.code, entry]),
);
`,

  "reference.ts": `${BANNER("scripts/error-guidance.mjs")}
export interface ReferenceSection {
  id: string;
  title: string;
  /** Markdown. */
  body: string;
}

export const REFERENCE_SECTIONS: ReferenceSection[] = ${json(sections)};

export const REFERENCE_SECTION_IDS = ${json(sections.map((s) => s.id))} as const;

export function referenceSection(id: string): string {
  if (id === "all") {
    return REFERENCE_SECTIONS.map((s) => s.body).join("\\n\\n---\\n\\n");
  }
  return REFERENCE_SECTIONS.find((s) => s.id === id)?.body ?? "";
}
`,
};

mkdirSync(OUT_DIR, { recursive: true });

const stale = [];
for (const [name, content] of Object.entries(files)) {
  const target = join(OUT_DIR, name);
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === content) continue;
  if (CHECK) stale.push(relative(ROOT, target));
  else writeFileSync(target, content);
}

if (CHECK) {
  if (stale.length) {
    console.error(`stale, run \`pnpm mcp:gen\`: ${stale.join(", ")}`);
    process.exit(1);
  }
  console.log(`MCP tool surface is current: ${operations.length + LOCAL_TOOLS.length} tools, ${actions.length} actions.`);
} else {
  console.log(
    `${operations.length} generated tools + ${LOCAL_TOOLS.length} local, ${actions.length} actions in the catalog, ` +
      `${refusals.length} documented refusals, ${errorCatalog.length} error codes, ` +
      `${sections.length} reference sections -> ${relative(ROOT, OUT_DIR).replace(/\\/g, "/")}/`,
  );
}
