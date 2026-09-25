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
// THE POLICY IS A RULE, NOT A LIST. Inclusion is decided by TAG, so a new endpoint under Articles
// becomes a tool with no hand edit, and a NEW TAG fails the build until somebody decides whether
// an assistant should reach it. That is the property API-6 acceptance test 9 asks for.

import { ERROR_GUIDANCE, ERROR_LINKS } from "./error-guidance.mjs";

/** Tags an assistant may reach. Every operation under one of these becomes a tool. */
export const TOOL_TAGS = [
  "Meta", "Articles", "Categories", "Tags", "Authors", "Media", "Pipeline", "Device sign-in",
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

/**
 * API-6 §2: "Descriptions matter more than the schema... a vague description is a production
 * incident." Each one is assembled from the spec so it states, in this order: what the operation
 * does, what it changes, what it costs, whether it needs confirming, and what key it needs.
 */
function describe(op, { method, confirm, scope, publishable }) {
  const summary = String(op.summary ?? "").trim().replace(/\.$/, "");
  const lines = [`${summary}. ${firstParagraph(op.description)}`.trim()];

  if (op["x-spends-credits"] === true) {
    lines.push(
      "COSTS MONEY: this spends the organisation's credit balance. It is the only billable tool here, and it is charged per unit of work the engine completes.",
    );
  }
  if (op["x-makes-public"] === true) {
    lines.push(
      "PUBLIC: this makes the article publicly visible on the customer's own live site, where search engines and readers will see it.",
    );
  }
  if (method === "DELETE") {
    lines.push("PERMANENT: this deletes content from the customer's Site. There is no trash and no undo.");
  }
  if (method !== "GET" && method !== "DELETE" && op["x-makes-public"] !== true && op["x-spends-credits"] !== true) {
    lines.push("Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call.");
  }
  if (method === "GET") {
    lines.push("Read only. Nothing is changed.");
  }
  if (confirm) {
    lines.push("Ask the user before calling this, and pass confirm: true only once they have agreed.");
  }
  if (scope !== "none") {
    lines.push(
      publishable
        ? `Needs a key carrying the ${scope} scope.`
        : `Needs a secret key (wv_sk_) carrying the ${scope} scope.`,
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
  for (const tag of declaredTags) {
    if (!TOOL_TAGS.includes(tag) && !(tag in NOT_TOOL_TAGS)) {
      bail(
        `openapi.yaml declares the tag "${tag}" and the MCP policy has no opinion about it. ` +
          `Add it to TOOL_TAGS to expose it to an assistant, or to NOT_TOOL_TAGS with a reason.`,
      );
    }
  }
  for (const tag of [...TOOL_TAGS, ...Object.keys(NOT_TOOL_TAGS)]) {
    if (!declaredTags.includes(tag)) {
      bail(`the MCP policy names the tag "${tag}", which openapi.yaml does not declare`);
    }
  }

  // -- the operations -------------------------------------------------------
  const operations = [];
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

      if (tag in NOT_TOOL_TAGS) {
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
        op["x-spends-credits"] === true
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

      operations.push({
        tool: NAME_OVERRIDES[operationId] ?? snake(operationId),
        operationId,
        method: upper,
        path,
        tag,
        summary: String(op.summary ?? "").trim(),
        description: describe(op, {
          method: upper,
          confirm: confirmReason !== null,
          scope,
          publishable: op["x-publishable"] === true,
        }),
        scope,
        entitlement: String(op["x-entitlement"] ?? "none"),
        publishable: op["x-publishable"] === true,
        spendsCredits: op["x-spends-credits"] === true,
        makesPublic: op["x-makes-public"] === true,
        readOnly: upper === "GET",
        confirm: confirmReason !== null,
        confirmReason,
        idempotency,
        ifMatch,
        params: [...params, ...body],
      });
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
  if (operations.length + refusals.length !== specOperations.length) {
    bail("an operation was neither exposed as a tool nor recorded as a refusal");
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
      lines.push(
        `## ${op.method} ${op.path}`,
        "",
        op.summary,
        "",
        `Scope: ${op.scope}. Publishable key: ${op.publishable ? "yes" : "no"}. Spends credits: ${op.spendsCredits ? "yes" : "no"}.`,
        tool
          ? `Tool: ${tool.tool}`
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
      "## What it deliberately cannot do",
      "",
      ...Object.entries(NOT_TOOL_TAGS).flatMap(([tag, reason]) => [`### ${tag}`, "", reason, ""]),
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

  return { operations, refusals, sections, errorCatalog, baseUrl, problems };
}
