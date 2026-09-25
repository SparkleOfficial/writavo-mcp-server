// mcp-surface — the policy that decides which endpoints an AI assistant may reach, and the
// compilation of openapi.yaml into the shape an MCP tool needs (API-6 §1, §2).
//
// A pure module with no side effects, imported by two generators:
//
//   scripts/gen-mcp-tools.mjs  ->  packages/mcp/src/generated/*   (the server itself)
//   scripts/gen-api-docs.mjs   ->  the /docs/mcp page's tool list
//
// One policy, two consumers. The published page cannot advertise a tool the server does not have,
// and the server cannot grow one the page does not list.
//
// THE POLICY IS A RULE, NOT A LIST. Inclusion is decided by TAG, so a new endpoint is reachable
// with no hand edit, and a NEW TAG fails the build until somebody decides whether an assistant
// should reach it. That is the property API-6 acceptance test 9 asks for.
//
// MCP-3 (decision 5) splits "reachable" in two. The everyday content operations of MCP-2 stay
// individual TOOLS; everything else an assistant may reach is an ACTION, listed in a catalog and
// reached through search_writavo_actions + run_writavo_action. Same schema compilation, same
// confirmation and approval rules, one less place for the two to disagree.

import { ERROR_GUIDANCE, ERROR_LINKS } from "./error-guidance.mjs";

/**
 * Tags an assistant may reach as INDIVIDUAL tools: the everyday content surface of MCP-2. Only the
 * operations in CORE_TOOL_OPERATIONS below become tools here; anything newer under one of these tags
 * is an ACTION (see ACTION_TAGS) unless the specification says otherwise.
 */
export const TOOL_TAGS = [
  "Meta", "Articles", "Categories", "Tags", "Authors", "Media", "Pipeline", "Device sign-in",
];

/**
 * MCP-3 (owner decision 5, 2026-09-25): everything past the everyday content tools is reached
 * through TWO tools, search_writavo_actions and run_writavo_action, not one tool per operation.
 * A client that loads 147 tool descriptions into every conversation spends its context on
 * settings nobody asked about; a search that returns the three operations that match costs
 * nothing until it is used.
 *
 * Every operation under one of these tags is an ACTION: it is in the actions catalog, never an
 * individual tool. A tag can also say so itself (`x-mcp-surface: action` on the tag object), and
 * one operation can override its tag (`x-mcp-surface: tool | action`). The decision lives in the
 * specification; this list is the default for the tags MCP-3 introduced (contract §10.1).
 */
export const ACTION_TAGS = [
  "Site settings", "Organisation", "Formats and prompts", "Delivery", "SEO", "Outreach", "Team", "Billing", "Insights",
];

/**
 * The operations that are individual tools: the MCP-2 surface, frozen by decision 5 ("keep
 * today's tools"). An operation under a TOOL_TAG that is not listed here (the MCP-3 pipeline
 * config, content plan and requeue routes, say) becomes an action by default, so the tool list a
 * client loads does not grow behind anybody's back. To make a new operation an individual tool,
 * put `x-mcp-surface: tool` on it in openapi.yaml: a decision, recorded in the contract.
 */
export const CORE_TOOL_OPERATIONS = [
  "ping", "getSite", "listContentTypes", "getUsage",
  "listArticles", "createArticle", "getArticle", "updateArticle", "deleteArticle", "publishArticle",
  "unpublishArticle", "scheduleArticle", "cancelArticleSchedule",
  "listCategories", "createCategory", "getCategory", "updateCategory", "deleteCategory",
  "listTags", "createTag", "getTag", "updateTag", "deleteTag",
  "listAuthors", "createAuthor", "getAuthor", "updateAuthor", "deleteAuthor",
  "listMedia", "getMediaAsset", "updateMediaAsset", "deleteMediaAsset",
  "listPipelineRuns", "createPipelineRun", "getPipelineRun", "listPipelineQueue",
];

/**
 * Tags whose writes change CONTENT (as opposed to settings, the team or billing). Their write
 * operations say "Changes content on the customer's Site. Nothing becomes public"; every other
 * write says which settings it changes instead (contract §10.2).
 */
export const CONTENT_TAGS = ["Articles", "Categories", "Tags", "Authors", "Media", "Pipeline", "Formats and prompts"];

/** The catalog's area for a tag: "Site settings" -> "site_settings". */
export const areaOf = (tag) => String(tag).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * What an AI agent can NEVER do through these tools, whatever it is granted, and the next step a
 * person takes instead (contract §9). Emitted into the `tools` reference section, so an assistant
 * asked "can you do X" answers with the exact link rather than guessing. Each is enforced server
 * side as well; this list is the explanation, not the defence. `keywords` are what
 * search_writavo_actions matches a request against, so "add a card" or "delete the site" returns the
 * next step instead of an operation that sounds close. It mirrors the table "What an AI
 * agent can never do" in openapi.yaml's info.description, row for row.
 */
export const NEVER_ACTIONS = [
  {
    what: "Change the AI agent switch, the approvals switch or the default permissions",
    keywords: "ai agent agents assistant assistants switch approval approvals default turn off on disable enable control controls setting settings change",
    why: "An agent must not be able to switch off the controls that govern it.",
    next_step: "A person changes this at https://app.writavo.com/settings/agents.",
  },
  {
    what: "Approve its own requests, or widen its own access",
    keywords: "approve approval own itself yourself self widen more scope scopes request requests access",
    why: "An approval is a person saying yes; an agent approving itself is no approval at all.",
    next_step: "The person approves at the link, or reconnects the assistant to choose more permissions.",
  },
  {
    what: "Change the access of the person it acts for (their role, their permissions, their role's permissions)",
    keywords: "own access yourself person act acts escalate widen change",
    why: "That would be an agent widening its own access by another route.",
    next_step: "That person, or another owner or admin, does it at https://app.writavo.com/team.",
  },
  {
    what: "Delete a Site or the organisation",
    keywords: "delete remove close destroy site organisation organization account workspace",
    why: "Irreversible, and it takes a live blog down for everyone.",
    next_step: "Not available to AI agents. The person contacts https://writavo.com/support.",
  },
  {
    what: "Enter or change payment details",
    keywords: "card cards credit debit payment method details add change update enter bank",
    why: "Card details never pass through an AI assistant.",
    next_step: "Add or change a card at https://app.writavo.com/billing?action=add-card.",
  },
  {
    what: "Change the plan",
    keywords: "plan change upgrade downgrade switch subscription tier",
    why: "A plan change is a purchase the person makes on Stripe's page.",
    next_step: "Get the plan link with start_plan_purchase (or https://app.writavo.com/billing) and give it to the person.",
  },
  {
    what: "Transfer ownership or make anyone an owner",
    keywords: "owner ownership transfer make promote",
    why: "Ownership is the last word on an organisation and changes hands only in person.",
    next_step: "The owner does it at https://app.writavo.com/team.",
  },
  {
    what: "Accept the outreach policy, pass identity checks, or connect an outreach mailbox",
    keywords: "outreach policy aup kyc identity check mailbox connect accept smtp imap",
    why: "Sending outreach is a legal commitment, and a mailbox password never passes through an AI assistant.",
    next_step: "An owner or a person with integrations access does it at https://app.writavo.com/outreach.",
  },
  {
    what: "Enter a CMS or Bing Webmaster Tools credential",
    keywords: "cms wordpress webflow ghost shopify wix bing webmaster credential credentials password token connect",
    why: "Third party credentials never pass through an AI assistant.",
    next_step: "The connect actions return the dashboard page where the person pastes it (https://app.writavo.com/delivery).",
  },
  {
    what: "Create, rotate or revoke API keys; manage webhooks",
    keywords: "api key keys webhook webhooks rotate revoke create mint",
    why: "A tool that can mint a credential is a tool whose compromise mints credentials.",
    next_step: "A person does this at https://app.writavo.com/settings/api-keys or https://app.writavo.com/settings/webhooks.",
  },
  {
    what: "Anything that needs Writavo platform staff",
    keywords: "platform admin staff internal superuser",
    why: "Platform administration is not something an organisation or its agents can reach.",
    next_step: "Not something an organisation can change. The person contacts https://writavo.com/support.",
  },
];

/**
 * Tags an assistant may NOT reach, and why. These are refusals with reasons rather than
 * omissions: the reason is generated into the package and shown by `get_api_docs`, so a user who
 * asks "why can you not rotate my key" gets an answer instead of a shrug.
 */
export const NOT_TOOL_TAGS = {
  "API keys":
    "Credential management stays in the dashboard. A server that can mint a secret key is a server whose compromise mints secret keys, and the key it would use to do so is sitting in a config file on the same machine.",
  Webhooks:
    "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately.",
};

/**
 * Tool names that read better than the operationId would. Everything else is the operationId in
 * snake case, so a new endpoint needs no entry here. Every key is asserted to exist in the spec.
 */
export const NAME_OVERRIDES = {
  ping: "verify_api_key",
  getSite: "get_site_info",
  listContentTypes: "get_content_types",
  createPipelineRun: "trigger_pipeline_run",
  getPipelineRun: "get_pipeline_status",
  listPipelineQueue: "get_pipeline_queue",
  getMediaAsset: "get_media",
  updateMediaAsset: "update_media",
  deleteMediaAsset: "delete_media",
};

/**
 * Operations folded into a single hand-written tool, and the tool that owns them. THE ONLY
 * grouping in the surface, and it earns its place: the upload is a three step handshake across
 * two endpoints and a presigned PUT, and a model asked to orchestrate that will get it wrong in a
 * way that leaves reserved uploads and orphaned objects behind.
 */
export const COMPOSED_INTO = {
  createMediaUploadUrl: "upload_media",
  registerMedia: "upload_media",
  // The device sign-in is the same shape of problem: a start call, a person acting in a browser,
  // and a poll loop that has to honour `interval` and `slow_down`. One tool owns all of it, and
  // the key it signs in with is generated and kept on the user's machine by that tool alone.
  startDeviceAuthorization: "login",
  pollDeviceAuthorization: "login",
};

/** What each composing tool drives, for the refusal reason a composed operation carries. */
const COMPOSED_WHAT = {
  upload_media: "upload handshake",
  login: "device sign-in",
};

/** Tools the package implements without a single endpoint behind them. */
export const LOCAL_TOOLS = [
  {
    name: "upload_media",
    scope: "media:write",
    summary: "Upload an image and register it in the media library, in one call.",
    confirm: false,
  },
  {
    name: "get_api_docs",
    scope: "none",
    summary: "Read the API reference offline. One of the few tools that needs no key.",
    confirm: false,
  },
  {
    name: "login",
    scope: "none",
    summary: "Sign in through the browser: a person approves, and a key generated on this machine goes live.",
    confirm: false,
  },
  {
    name: "login_status",
    scope: "none",
    summary: "Check whether a sign-in started with login has been approved, and which Site it is for.",
    confirm: false,
  },
  {
    name: "logout",
    scope: "none",
    summary: "Sign out on this machine: revoke the signed-in key on the server, then forget it locally.",
    confirm: false,
  },
  {
    name: "start_plan_purchase",
    scope: "none",
    summary: "Get the dashboard link to choose a plan. Payment happens on Stripe's page, never in the chat.",
    confirm: false,
  },
  {
    name: "import_content",
    scope: "articles:write",
    summary: "Import articles from a Writavo import file: dry run first, then create, re-host images and publish with original dates.",
    confirm: true,
  },
  {
    name: "search_writavo_actions",
    scope: "none",
    summary: "Find the operation for a settings, delivery, SEO, team, billing or insights task, with its input schema and whether it needs approval or costs money.",
    confirm: false,
  },
  {
    name: "read_writavo_action",
    scope: "per action",
    summary: "Run one READ operation found with search_writavo_actions (settings, SEO, team, billing, insights). Changes nothing.",
    confirm: false,
  },
  {
    name: "run_writavo_action",
    scope: "per action",
    summary: "Run one operation that CHANGES something, found with search_writavo_actions, validated against its schema, with the same confirmation and approval steps as every other tool.",
    confirm: true,
  },
];

const METHODS = ["get", "post", "patch", "delete"];
const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The first paragraph, flattened to one line and stripped of markdown emphasis. */
function firstParagraph(markdown, limit = 420) {
  const text = String(markdown ?? "")
    .split(/\n\s*\n/)[0]
    .replace(/\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastStop = cut.lastIndexOf(". ");
  return lastStop > 120 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}...`;
}

/** `x-also-scopes`: further scopes the key must carry besides `x-scope` (contract §4.1 alsoScopes). */
function alsoScopesOf(op) {
  const raw = op["x-also-scopes"];
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

/** `x-agent-consequence`: the one sentence a person agrees to (contract §10.1), or null. */
function consequenceOf(op) {
  const raw = op["x-agent-consequence"];
  const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return text.length > 0 ? text : null;
}

/** "Changes Site settings." / "Changes Team settings." for the writes that are not content. */
function changesLine(tag) {
  const name = String(tag || "account");
  return /settings$/i.test(name) ? `Changes ${name}.` : `Changes ${name} settings.`;
}

/**
 * API-6 §2: "Descriptions matter more than the schema... a vague description is a production
 * incident." Each one is assembled from the spec so it states, in this order: what the operation
 * does, what it changes, what it costs, whether it needs confirming, and what key it needs.
 *
 * MCP-3: the consequence line comes from `x-agent-consequence` when the operation carries one,
 * because the old fixed sentences ("deletes content", "takes live content down") are wrong for
 * revoking an invite or removing a member. `x-spends-money` marks a cost that is not credits (a
 * custom domain, a rank check) and reads exactly like a credit spend.
 */
function describe(op, { method, confirm, scope, publishable, tag }) {
  const summary = String(op.summary ?? "").trim().replace(/\.$/, "");
  const lines = [`${summary}. ${firstParagraph(op.description)}`.trim()];
  const consequence = consequenceOf(op);
  const spendsCredits = op["x-spends-credits"] === true;
  const spendsMoney = op["x-spends-money"] === true;
  let consequenceSaid = false;

  if (spendsCredits) {
    lines.push(
      `COSTS MONEY: this spends the organisation's credit balance, charged per unit of work completed.${consequence ? ` ${consequence}` : ""}`,
    );
    consequenceSaid = consequence !== null;
  } else if (spendsMoney) {
    lines.push(`COSTS MONEY: ${consequence ?? "this costs the organisation money."}`);
    consequenceSaid = consequence !== null;
  }
  if (op["x-makes-public"] === true) {
    lines.push(
      "PUBLIC: this makes the article publicly visible on the customer's own live site, where search engines and readers will see it.",
    );
  }
  if (method === "DELETE") {
    lines.push(
      consequence && !consequenceSaid
        ? `PERMANENT: ${consequence}`
        : "PERMANENT: this deletes content from the customer's Site. There is no trash and no undo.",
    );
    consequenceSaid = consequenceSaid || consequence !== null;
  }
  if (method !== "GET" && method !== "DELETE" && op["x-makes-public"] !== true && !spendsCredits && !spendsMoney) {
    lines.push(
      CONTENT_TAGS.includes(tag)
        ? "Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call."
        : changesLine(tag),
    );
  }
  if (consequence && !consequenceSaid) lines.push(`CONSEQUENCE: ${consequence}`);
  if (method === "GET") {
    lines.push("Read only. Nothing is changed.");
  }
  if (confirm) {
    lines.push("Ask the user before calling this, and pass confirm: true only once they have agreed.");
  }
  if (scope !== "none") {
    const scopes = [scope, ...alsoScopesOf(op)];
    const named = scopes.length > 1 ? `the ${scopes.join(" and ")} scopes` : `the ${scope} scope`;
    lines.push(
      publishable
        ? `Needs a key carrying ${named}.`
        : `Needs a secret key (wv_sk_) carrying ${named}.`,
    );
  }
  return lines.join(" ");
}

/**
 * Compile a parsed openapi.yaml into the MCP surface.
 *
 * Never throws on a bad spec: problems are collected so a caller can report all of them at once,
 * the way the sibling generators do.
 */
export function buildMcpSurface(spec) {
  const problems = [];
  const bail = (msg) => problems.push(msg);

  const deref = (node) => {
    if (node && typeof node === "object" && node.$ref) {
      const [, section, kind, name] = node.$ref.split("/");
      return spec[section]?.[kind]?.[name] ?? {};
    }
    return node ?? {};
  };

  /**
   * A JSON Schema node reduced to what a tool input needs: a kind, whether null is allowed, and
   * the enum if there is one. Deliberately lossy. Length limits, patterns and cross-field rules
   * are the API's job, and duplicating them here would be a second copy of the contract that can
   * go stale while still compiling.
   */
  function descriptorOf(schema) {
    const node = schema?.$ref ? deref(schema) : (schema ?? {});
    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    const nullable = types.includes("null");
    const base =
      types.filter((t) => t !== "null")[0] ?? (node.properties ? "object" : node.enum ? "string" : "string");

    const out = { kind: base, nullable };
    if (node.enum) out.enum = node.enum.map(String);
    if (node.format) out.format = String(node.format);
    if (base === "array") {
      const item = node.items?.$ref ? deref(node.items) : (node.items ?? {});
      const itemTypes = Array.isArray(item.type) ? item.type : item.type ? [item.type] : [];
      out.itemKind = itemTypes.filter((t) => t !== "null")[0] ?? "string";
      if (item.enum) out.itemEnum = item.enum.map(String);
    }
    return out;
  }

  function paramsOf(pathItem, op) {
    const raw = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])].map(deref);
    const params = [];
    let idempotency = false;
    let ifMatch = false;

    for (const p of raw) {
      const where = String(p.in ?? "query");
      if (where === "header") {
        // Never a tool argument. `Idempotency-Key` is generated per call, which is the whole point
        // of it: a model asked to invent one would reuse it, and a reused key with a different
        // body is a 409 rather than the retry safety it exists to provide.
        if (p.name === "Idempotency-Key") idempotency = true;
        if (p.name === "If-Match") ifMatch = true;
        continue;
      }
      params.push({
        name: String(p.name),
        in: where,
        required: p.required === true,
        description: firstParagraph(p.description, 300),
        explode: p.explode === true,
        ...descriptorOf(p.schema),
      });
    }
    return { params, idempotency, ifMatch };
  }

  function bodyParamsOf(op) {
    const schema = op.requestBody?.content?.["application/json"]?.schema;
    if (!schema) return [];
    const resolved = schema.$ref ? deref(schema) : schema;
    if (!resolved.properties) return [];
    const required = new Set(resolved.required ?? []);
    return Object.entries(resolved.properties).map(([name, prop]) => ({
      name,
      in: "body",
      required: required.has(name),
      description: firstParagraph(prop?.description ?? deref(prop).description, 300),
      explode: false,
      ...descriptorOf(prop),
    }));
  }

  // -- the tag gate ---------------------------------------------------------
  const declaredTags = (spec.tags ?? []).map((t) => String(t.name));
  const tagSurface = new Map((spec.tags ?? []).map((t) => [String(t.name), t?.["x-mcp-surface"]]));
  const actionTag = (tag) => ACTION_TAGS.includes(tag) || tagSurface.get(tag) === "action";
  for (const [tag, value] of tagSurface) {
    if (value !== undefined && value !== "action" && value !== "tool") {
      bail(`the tag "${tag}" carries x-mcp-surface: ${JSON.stringify(value)}; the values are "tool" and "action"`);
    }
  }
  for (const tag of declaredTags) {
    if (!TOOL_TAGS.includes(tag) && !(tag in NOT_TOOL_TAGS) && !actionTag(tag)) {
      bail(
        `openapi.yaml declares the tag "${tag}" and the MCP policy has no opinion about it. ` +
          `Add it to TOOL_TAGS or ACTION_TAGS (or mark the tag x-mcp-surface: action) to expose it to an assistant, ` +
          `or to NOT_TOOL_TAGS with a reason.`,
      );
    }
  }
  // ACTION_TAGS may run ahead of the specification (a contract lands its tags one route at a
  // time); the tool tags and the refusals may not.
  for (const tag of [...TOOL_TAGS, ...Object.keys(NOT_TOOL_TAGS)]) {
    if (!declaredTags.includes(tag)) {
      bail(`the MCP policy names the tag "${tag}", which openapi.yaml does not declare`);
    }
  }

  // -- the operations -------------------------------------------------------
  const operations = [];
  const actions = [];
  const refusals = [];
  const specOperations = [];
  const allOperationIds = new Set();

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const operationId = String(op.operationId ?? "");
      allOperationIds.add(operationId);

      const tag = String(op.tags?.[0] ?? "");
      const scope = String(op["x-scope"] ?? "none");
      const upper = method.toUpperCase();

      specOperations.push({
        operationId,
        method: upper,
        path,
        tag,
        scope,
        summary: String(op.summary ?? "").trim(),
        description: String(op.description ?? "").trim(),
        publishable: op["x-publishable"] === true,
        spendsCredits: op["x-spends-credits"] === true,
      });

      const explicitSurface = op["x-mcp-surface"];
      if (explicitSurface !== undefined && explicitSurface !== "tool" && explicitSurface !== "action") {
        bail(`${upper} ${path}: x-mcp-surface must be "tool" or "action", got ${JSON.stringify(explicitSurface)}`);
      }

      if (tag in NOT_TOOL_TAGS) {
        if (explicitSurface !== undefined) {
          bail(`${upper} ${path}: x-mcp-surface on an operation under "${tag}", which assistants may not reach at all`);
        }
        refusals.push({ operationId, method: upper, path, tag, reason: NOT_TOOL_TAGS[tag] });
        continue;
      }
      if (COMPOSED_INTO[operationId]) {
        refusals.push({
          operationId,
          method: upper,
          path,
          tag,
          reason: `Reached through the ${COMPOSED_INTO[operationId]} tool, which drives the whole ${COMPOSED_WHAT[COMPOSED_INTO[operationId]] ?? "exchange"} in one call.`,
        });
        continue;
      }

      const { params, idempotency, ifMatch } = paramsOf(item, op);
      const body = bodyParamsOf(op);

      // A body field and a query field of the same name would collapse into one tool argument and
      // silently land in whichever half the client checked first.
      for (const b of body) {
        const clash = params.find((p) => p.name === b.name);
        if (clash) bail(`${upper} ${path}: "${b.name}" is both a ${clash.in} parameter and a body field`);
      }

      // Confirmation is DERIVED, so a future endpoint that spends money or deletes content
      // inherits the gate instead of waiting for somebody to remember it (API-6 §2).
      const confirmReason =
        op["x-spends-credits"] === true || op["x-spends-money"] === true
          ? "spend"
          : upper === "DELETE"
            ? "destructive"
            : op["x-writavo-approval"]
              // The server makes an agent key get a person's approval for this (0089), so the
              // tool asks first too: taking something down is as consequential as deleting it.
              ? "approval"
              : op["x-makes-public"] === true
                ? "public"
                : null;

      // Tool or action (decision 5). The operation's own x-mcp-surface wins; then its tag; then
      // the frozen MCP-2 list, so anything new under a content tag lands in the catalog.
      const surfaceKind =
        explicitSurface ??
        (actionTag(tag) ? "action" : TOOL_TAGS.includes(tag) && CORE_TOOL_OPERATIONS.includes(operationId) ? "tool" : "action");

      const consequence = consequenceOf(op);
      const spendsMoney = op["x-spends-money"] === true;
      if (spendsMoney && !consequence) {
        bail(`${upper} ${path}: x-spends-money needs an x-agent-consequence saying what it costs`);
      }
      if (surfaceKind === "action" && !consequence && (upper === "DELETE" || op["x-writavo-approval"])) {
        bail(
          `${upper} ${path}: an action that deletes or needs approval must carry x-agent-consequence, the one sentence a person agrees to`,
        );
      }

      const row = {
        tool: NAME_OVERRIDES[operationId] ?? snake(operationId),
        operationId,
        method: upper,
        path,
        tag,
        surface: surfaceKind,
        area: areaOf(tag),
        summary: String(op.summary ?? "").trim(),
        brief: firstParagraph(op.description, 240),
        description: describe(op, {
          method: upper,
          confirm: confirmReason !== null,
          scope,
          publishable: op["x-publishable"] === true,
          tag,
        }),
        scope,
        alsoScopes: alsoScopesOf(op),
        entitlement: String(op["x-entitlement"] ?? "none"),
        publishable: op["x-publishable"] === true,
        spendsCredits: op["x-spends-credits"] === true,
        spendsMoney,
        consequence,
        makesPublic: op["x-makes-public"] === true,
        readOnly: upper === "GET",
        confirm: confirmReason !== null,
        confirmReason,
        idempotency,
        ifMatch,
        params: [...params, ...body],
      };
      if (surfaceKind === "tool") operations.push(row);
      else actions.push(row);
    }
  }

  for (const id of CORE_TOOL_OPERATIONS) {
    if (!allOperationIds.has(id)) bail(`CORE_TOOL_OPERATIONS names "${id}", which openapi.yaml no longer defines`);
  }
  for (const a of actions) {
    // run_writavo_action refuses anything it cannot put on the wire from flat arguments.
    for (const p of a.params) {
      if (["operation_id", "arguments", "approval_id", "confirm"].includes(p.name)) {
        bail(`${a.method} ${a.path}: the argument "${p.name}" would collide with run_writavo_action's own`);
      }
    }
  }

  for (const [id, tool] of Object.entries(COMPOSED_INTO)) {
    if (!allOperationIds.has(id)) bail(`COMPOSED_INTO names "${id}", which openapi.yaml no longer defines`);
    if (!LOCAL_TOOLS.some((t) => t.name === tool)) {
      bail(`COMPOSED_INTO folds "${id}" into "${tool}", which is not a local tool`);
    }
  }
  for (const id of Object.keys(NAME_OVERRIDES)) {
    if (!allOperationIds.has(id)) bail(`NAME_OVERRIDES names "${id}", which openapi.yaml no longer defines`);
  }
  {
    const names = [...operations.map((o) => o.tool), ...LOCAL_TOOLS.map((t) => t.name)];
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    if (dupes.length) bail(`two tools would share the name(s): ${[...new Set(dupes)].join(", ")}`);
    for (const name of names) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) bail(`"${name}" is not a usable tool name`);
    }
  }
  {
    const ids = actions.map((a) => a.operationId);
    const dupes = ids.filter((n, i) => ids.indexOf(n) !== i);
    if (dupes.length) bail(`two actions share the operationId(s): ${[...new Set(dupes)].join(", ")}`);
  }
  if (operations.length + actions.length + refusals.length !== specOperations.length) {
    bail("an operation was neither exposed as a tool or an action nor recorded as a refusal");
  }

  // -- the reference text ---------------------------------------------------
  const baseUrl = String(spec.servers?.[0]?.url ?? "");
  const schemaProse = (name) => String(spec.components?.schemas?.[name]?.description ?? "").trim();

  const sections = [];
  const section = (id, title, body) => sections.push({ id, title, body: body.trim() });

  section(
    "overview",
    "Overview",
    [
      `# ${spec.info?.title ?? ""} v${spec.info?.version ?? ""}`,
      "",
      String(spec.info?.summary ?? ""),
      "",
      `Base URL: ${baseUrl}`,
      `Full documentation: ${spec.externalDocs?.url ?? ""}`,
      "",
      String(spec.info?.description ?? "").trim(),
    ].join("\n"),
  );

  section(
    "authentication",
    "Authentication, keys and scopes",
    [
      "# Authentication",
      "",
      String(spec.components?.securitySchemes?.apiKey?.description ?? "").trim(),
      "",
      "## Key kinds",
      "",
      schemaProse("KeyKind"),
      "",
      "## Scopes",
      "",
      schemaProse("Scope"),
      "",
      "The scopes themselves:",
      "",
      ...(spec.components?.schemas?.Scope?.enum ?? []).map((s) => `- ${s}`),
    ].join("\n"),
  );

  section(
    "errors",
    "Error codes and what to do about them",
    [
      "# Errors",
      "",
      schemaProse("ErrorCode"),
      "",
      "## What to do about each one",
      "",
      ...Object.entries(ERROR_GUIDANCE).flatMap(([code, action]) => [
        `### ${code}`,
        "",
        action,
        ...(ERROR_LINKS[code] ?? []).map((l) => `- ${l.label}: ${l.url}`),
        "",
      ]),
    ].join("\n"),
  );

  for (const tag of spec.tags ?? []) {
    const name = String(tag.name);
    const lines = [`# ${name}`, "", String(tag.description ?? "").trim(), ""];
    if (name in NOT_TOOL_TAGS) lines.push(`Not available as tools. ${NOT_TOOL_TAGS[name]}`, "");
    for (const op of specOperations.filter((o) => o.tag === name)) {
      const tool = operations.find((t) => t.operationId === op.operationId);
      const action = actions.find((a) => a.operationId === op.operationId);
      lines.push(
        `## ${op.method} ${op.path}`,
        "",
        op.summary,
        "",
        `Scope: ${op.scope}. Publishable key: ${op.publishable ? "yes" : "no"}. Spends credits: ${op.spendsCredits ? "yes" : "no"}.`,
        tool
          ? `Tool: ${tool.tool}`
          : action
            ? `Tool: ${action.method === "GET" ? "read_writavo_action" : "run_writavo_action"} with operation_id "${action.operationId}" (find it with search_writavo_actions).`
            : `Tool: none.${COMPOSED_INTO[op.operationId] ? ` Covered by ${COMPOSED_INTO[op.operationId]}.` : ""}`,
        "",
        op.description,
        "",
      );
    }
    section(slugify(name), name, lines.join("\n"));
  }

  section(
    "tools",
    "What this server exposes",
    [
      "# Tools",
      "",
      "Every tool below is compiled from the same specification this reference is generated from, so a tool cannot describe an endpoint that does not exist and cannot accept a field the API refuses.",
      "",
      ...operations.map((o) => `- ${o.tool}: ${o.method} ${o.path}${o.confirm ? " (asks you first)" : ""}`),
      ...LOCAL_TOOLS.map((t) => `- ${t.name}: ${t.summary}`),
      "",
      "## Actions (search_writavo_actions, then run_writavo_action)",
      "",
      actions.length > 0
        ? "Settings, delivery, SEO, the team, billing and insights are not separate tools. Find the operation with search_writavo_actions (a few words, optionally an area), then call read_writavo_action (for a GET, which changes nothing) or run_writavo_action (for everything else) with its operation_id and arguments. Confirmation and approval work exactly as they do for every other tool."
        : "This version of the specification has no actions yet.",
      "",
      ...actions.map((a) => {
        const notes = [
          a.spendsCredits ? "spends credits" : a.spendsMoney ? "costs money" : null,
          a.confirm ? "asks you first" : null,
        ].filter(Boolean);
        const runner = a.method === "GET" ? "read" : "run";
        return `- ${a.operationId} (${a.area}, ${runner}): ${a.method} ${a.path}${notes.length ? ` (${notes.join(", ")})` : ""}`;
      }),
      "",
      "## What it deliberately cannot do",
      "",
      ...Object.entries(NOT_TOOL_TAGS).flatMap(([tag, reason]) => [`### ${tag}`, "", reason, ""]),
      "## Never through an AI agent",
      "",
      "Whatever permissions a connection carries, these stay with a person. Give them the next step exactly as written.",
      "",
      ...NEVER_ACTIONS.flatMap((n) => [`### ${n.what}`, "", `${n.why} ${n.next_step}`, ""]),
    ].join("\n"),
  );

  {
    const ids = sections.map((s) => s.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length) bail(`two reference sections share the id(s): ${[...new Set(dupes)].join(", ")}`);
  }

  // -- the error catalog ----------------------------------------------------
  const errorCatalog = [];
  for (const line of String(spec.components?.schemas?.ErrorCode?.description ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim().replace(/`/g, ""));
    if (cells.length !== 3 || cells.every((c) => /^-+$/.test(c)) || cells[0] === "Code") continue;
    errorCatalog.push({
      code: cells[0],
      http: cells[1],
      meaning: cells[2],
      action: String(ERROR_GUIDANCE[cells[0]] ?? ""),
      links: ERROR_LINKS[cells[0]] ?? [],
    });
  }
  for (const row of errorCatalog) {
    if (!row.action) bail(`error code ${row.code} has no guidance in scripts/error-guidance.mjs`);
  }

  return { operations, actions, refusals, sections, errorCatalog, baseUrl, problems };
}
