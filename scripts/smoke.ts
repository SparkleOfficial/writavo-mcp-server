/**
 * Writavo MCP server, smoke test.
 * =================================================================================
 *
 * Runs entirely offline, against the runtime-agnostic core the hosted server at
 * https://mcp.writavo.com/mcp mounts (the only Writavo MCP server; the npm stdio package is
 * discontinued, owner ruling 2026-09-28). It covers every API-6 acceptance test that does not need
 * a deployed API:
 *
 *   1  the generated surface is coherent
 *   2  a real MCP client (in memory) against the core with no key: initialize, the hosted
 *      instructions, tools/list, resources/list, prompts/list, and the calls that need no key
 *   4  the no-key experience, with the real links
 *   5  the scope probe: a publishable key naming the scope it lacks
 *   6  the credit probe: an exhausted balance producing an actionable message with a billing link
 *   7  the confirmation probe, asserted by counting requests that reached the API (zero)
 *   8  the leak probe, including an API that echoes the key back in an error
 *  10  the em-dash ban across every user-visible string
 *  13  the plan purchase link
 *  14  the importer, through stored imports (the hosted import jobs): validation, dry run, apply,
 *      re-run as a no-op, update in place by a part sent with the import_id, retry_failed, and
 *      content kept verbatim except for re-hosted image URLs
 *  14b stored imports: one-pass checks, parts, upload links, leases, request budgets
 *  15  MCP-2: the core as the Worker mounts it (the tool list, annotations on every tool, inline
 *      import and base64 upload), approvals (approval_id on gated tools, a 428 turned into an
 *      instruction, the refusal codes), the Writavo-Mcp-Tool header, the generator's handling of
 *      x-writavo-approval and of the host-owned /auth/key/* routes, the package manifests, and the
 *      whole package's import graph staying free of the filesystem and the environment
 *  16  MCP-3: the actions catalog (a fixture specification through the real generator), the
 *      search ranking, run_writavo_action's schema validation, unknown-operation refusal, the
 *      confirmation step and the approval passthrough, and the hosted instructions
 *
 * The live round trip is scripts/integration.ts, which needs a real key and a deployed API.
 *
 *   pnpm --filter @writavo/mcp-server smoke
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

// upload_media and import_content fetch images from URLs the caller names, which is exactly what
// openWorldHint describes. Every other tool only ever talks to the Writavo API.
const OPEN_WORLD_TOOLS = new Set(["upload_media", "import_content"]);

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");

const SECRET_KEY = "wv_sk_smoke0000000000000000000000000000000000";
const PUBLISHABLE_KEY = "wv_pub_smoke00000000000000000000000000000000";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];

function check(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n          ${detail}`}`);
  return ok;
}

// ---------------------------------------------------------------------------
// A stub API on loopback, passed to the core as its apiBase exactly as the Worker passes its own.
// ---------------------------------------------------------------------------
interface StubRequest {
  method: string;
  path: string;
  hasAuth: boolean;
  authorization: string | null;
  idempotencyKey: string | null;
  approval: string | null;
  mcpTool: string | null;
  worker: string | null;
  userAgent: string | null;
  body: string;
}

class StubApi {
  requests: StubRequest[] = [];
  respond: (req: StubRequest) => { status: number; body: unknown } = () => ({
    status: 200,
    body: { ok: true, data: {} },
  });

  private server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const record: StubRequest = {
        method: req.method ?? "",
        path: req.url ?? "",
        hasAuth: Boolean(req.headers.authorization),
        authorization: req.headers.authorization ?? null,
        idempotencyKey: (req.headers["idempotency-key"] as string | undefined) ?? null,
        approval: (req.headers["writavo-approval"] as string | undefined) ?? null,
        mcpTool: (req.headers["writavo-mcp-tool"] as string | undefined) ?? null,
        worker: (req.headers["x-writavo-mcp-worker"] as string | undefined) ?? null,
        userAgent: (req.headers["user-agent"] as string | undefined) ?? null,
        body,
      };
      this.requests.push(record);
      const { status, body: payload } = this.respond(record);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });

  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const { port } = this.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}/v1`);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  reset(): void {
    this.requests = [];
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("================================================");
  console.log("  Writavo MCP server, smoke test (offline)");
  console.log("================================================");

  const stub = new StubApi();
  const baseUrl = await stub.listen();

  const { createWritavoMcpServer, toolContext, CORE_LOCAL_TOOL_NAMES, VERSION, redact } = await import("../src/core/index.js");
  const { OPERATIONS, REFUSALS } = await import("../src/generated/operations.js");
  const { ERROR_CATALOG } = await import("../src/generated/errors.js");
  const { REFERENCE_SECTIONS } = await import("../src/generated/reference.js");
  const { callOperation } = await import("../src/tools/call.js");
  const { handleGetApiDocs } = await import("../src/tools/api-docs.js");
  const { handleUploadMedia } = await import("../src/tools/upload-media.js");
  const { inputShapeFor } = await import("../src/tools/schema.js");
  const { START_PLAN_PURCHASE, handleStartPlanPurchase } = await import("../src/tools/plan-purchase.js");
  const { IMPORT_CONTENT, handleImportContent, importContentTool } = await import("../src/tools/import-content.js");
  const { UPLOAD_MEDIA } = await import("../src/tools/upload-media.js");
  const { NOT_SIGNED_IN_REMOTE } = await import("../src/core/messages.js");
  const { IMPORT_FORMAT_GUIDE, IMPORT_SAMPLE, ImportDocumentSchema, importFormatJsonSchema } = await import("../src/import/format.js");
  const { migrateContentPrompt } = await import("../src/prompts/migrate-content.js");

  const bodyOf = (result: { content?: { text?: string }[] }): string =>
    (result.content ?? []).map((c) => c.text ?? "").join("\n");
  const operation = (tool: string) => {
    const found = OPERATIONS.find((o) => o.tool === tool);
    if (!found) throw new Error(`no generated operation for ${tool}`);
    return found;
  };
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  // The connection's key, as the Worker hands it to the core per request: null is "not signed in".
  let currentKey: string | null = null;
  const USER_AGENT = `writavo-mcp-server/${VERSION}`;
  const CTX = toolContext({ apiKey: () => currentKey, apiBase: baseUrl, userAgent: USER_AGENT, host: "remote" });

  // A store that behaves like the Worker's Durable Objects: scoped to one owner, strongly
  // consistent. Every import below runs through one, as every import on the hosted server does.
  type ImportJobStore = import("../src/import/jobs.js").ImportJobStore;
  const jobRows = new Map<string, { owner: string; doc: string | null; progress: string | null; lease?: { holder: string; until: number }; uploadHash?: string }>();
  const memStore = (owner: string): ImportJobStore => {
    const row = (id: string) => {
      const r = jobRows.get(id);
      return r && r.owner === owner ? r : null;
    };
    return {
      async create() {
        const id = `imp_${randomUUID().replace(/-/g, "").slice(0, 22)}`;
        jobRows.set(id, { owner, doc: null, progress: null });
        return id;
      },
      async info(id) {
        const r = row(id);
        return r ? { status: r.doc === null ? "awaiting_upload" : "ready", bytes: r.doc?.length ?? 0, created_at: "", updated_at: "" } : null;
      },
      async getDocument(id) { return row(id)?.doc ?? null; },
      async putDocument(id, json) { const r = row(id); if (!r) throw new Error("gone"); r.doc = json; },
      async readProgress(id) { return row(id)?.progress ?? null; },
      async writeProgress(id, json) { const r = row(id); if (!r) throw new Error("gone"); r.progress = json; },
      async acquire(id, holder, ttl) {
        const r = row(id);
        if (!r) return { ok: false, until: null };
        if (r.lease && r.lease.holder !== holder && r.lease.until > Date.now()) return { ok: false, until: r.lease.until };
        r.lease = { holder, until: Date.now() + ttl };
        return { ok: true, until: r.lease.until };
      },
      async release(id, holder) { const r = row(id); if (r?.lease?.holder === holder) delete r.lease; },
      async createUpload(id) { const r = row(id)!; r.uploadHash = "t"; return { url: `https://mcp.example.test/imports/${id}`, token: "T".repeat(43), expires_at: "2099-01-01T00:00:00Z" }; },
    };
  };

  // -- 1. the generated surface ---------------------------------------------
  console.log("\n[ 1. The generated surface ]");
  check(`${OPERATIONS.length} operations became tools`, OPERATIONS.length > 30);
  check(`${REFUSALS.length} operations are documented refusals`, REFUSALS.length > 0);
  check("every refusal carries a reason", REFUSALS.every((r) => r.reason.length > 40));
  check(
    "every tool name is unique and well formed",
    new Set(OPERATIONS.map((o) => o.tool)).size === OPERATIONS.length &&
      OPERATIONS.every((o) => /^[a-z][a-z0-9_]*$/.test(o.tool)),
  );
  check(
    "every input schema builds",
    OPERATIONS.every((o) => Object.keys(inputShapeFor(o)).length >= o.params.length),
  );
  check(
    "the three tools API-6 names as needing confirmation do",
    ["publish_article", "delete_article", "trigger_pipeline_run"].every((t) => operation(t).confirm),
  );
  check(
    "every DELETE and every billable tool needs confirmation",
    OPERATIONS.filter((o) => o.method === "DELETE" || o.spendsCredits).every((o) => o.confirm),
  );
  check(
    "trigger_pipeline_run says it costs money",
    /COSTS MONEY/.test(operation("trigger_pipeline_run").description),
  );
  check(
    "publish_article says it goes public on the customer's live site",
    /publicly visible on the customer's own live site/.test(operation("publish_article").description),
  );
  check(`${ERROR_CATALOG.length} error codes each have guidance`, ERROR_CATALOG.every((e) => e.action.length > 20));
  check(`${REFERENCE_SECTIONS.length} reference sections all have a body`, REFERENCE_SECTIONS.every((s) => s.body.length > 50));

  // -- 10. em-dashes ---------------------------------------------------------
  const userVisible = [
    ...OPERATIONS.flatMap((o) => [o.description, o.summary, ...o.params.map((p) => p.description)]),
    ...REFUSALS.map((r) => r.reason),
    ...ERROR_CATALOG.flatMap((e) => [e.meaning, e.action, ...e.links.map((l) => l.label)]),
    ...REFERENCE_SECTIONS.map((s) => s.body),
    ...[START_PLAN_PURCHASE, IMPORT_CONTENT, importContentTool(memStore("g:em-dash")), UPLOAD_MEDIA].map((t) => t.description),
    NOT_SIGNED_IN_REMOTE,
    migrateContentPrompt({}).messages[0]!.content.text,
    IMPORT_FORMAT_GUIDE,
  ];
  const withDash = userVisible.filter((s) => /[—–]/.test(s));
  check(`10. no em-dash or en-dash in ${userVisible.length} user-visible strings`, withDash.length === 0, withDash[0]?.slice(0, 120) ?? "");

  // -- 2. a real MCP client against the core, no key ---------------------------
  console.log("\n[ 2. A real MCP client (in memory) against the hosted core, no key ]");
  {
    // Deliberately no key: the tool list must load for someone who has not signed in yet.
    const server = createWritavoMcpServer({ apiKey: () => null, apiBase: baseUrl, userAgent: USER_AGENT, host: "remote" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "writavo-mcp-smoke", version: "1.0.0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    stub.reset();

    const serverInfo = client.getServerVersion();
    check("the server completes the MCP initialize handshake and identifies itself as writavo with a version", serverInfo?.name === "writavo" && serverInfo?.version === VERSION);
    const instructions = client.getInstructions() ?? "";
    check(
      `the instructions (${instructions.length} characters) stay under 6000, point at the actions and carry no dashes`,
      instructions.length > 0 && instructions.length < 6000 && instructions.includes("search_writavo_actions") &&
        instructions.includes("run_writavo_action") && instructions.includes("read_writavo_action") && !/[\u2014\u2013]/.test(instructions),
    );
    check(
      "the instructions describe the hosted server only: browser sign-in, stored imports, no login tool, no local files",
      instructions.includes("https://mcp.writavo.com/mcp") && instructions.includes("import_id") && instructions.includes("upload: true") &&
        !/\blogin(_status)?\b/.test(instructions) && !/on this machine|absolute path|npx|@writavo\/mcp-server/.test(instructions),
      instructions.slice(0, 300),
    );

    const tools = (await client.listTools()).tools;
    check(
      `the tool list loads: ${tools.length} tools`,
      tools.length === OPERATIONS.length + CORE_LOCAL_TOOL_NAMES.length,
      `expected ${OPERATIONS.length + CORE_LOCAL_TOOL_NAMES.length} (${OPERATIONS.length} generated plus ${CORE_LOCAL_TOOL_NAMES.join(", ")}), got ${tools.length}`,
    );
    check(
      "every hand-written tool is listed",
      CORE_LOCAL_TOOL_NAMES.every((name) => tools.some((t) => t.name === name)),
      CORE_LOCAL_TOOL_NAMES.filter((name) => !tools.some((t) => t.name === name)).join(", "),
    );
    check(
      "every tool carries a description and an input schema",
      tools.every((t) => t.description && t.description.length > 40 && t.inputSchema),
      tools.filter((t) => !t.description || t.description.length <= 40).map((t) => t.name).join(", "),
    );
    check(
      "no tool takes a local path",
      tools.every((t) => !("path" in ((t.inputSchema as { properties?: object }).properties ?? {}))),
      tools.filter((t) => "path" in ((t.inputSchema as { properties?: object }).properties ?? {})).map((t) => t.name).join(", "),
    );

    const resources = (await client.listResources()).resources;
    check(
      "the four resources are listed, including the import format",
      resources.length === 4 && resources.some((r) => r.uri === "writavo://import-format"),
      resources.map((r) => r.uri).join(", "),
    );
    const prompts = (await client.listPrompts()).prompts;
    check(
      "all three prompts are listed",
      prompts.length === 3 && ["draft-article", "publish-checklist", "migrate-content"].every((name) => prompts.some((p) => p.name === name)),
      prompts.map((p) => p.name).join(", "),
    );
    const migrate = JSON.stringify((await client.getPrompt({ name: "migrate-content", arguments: {} })).messages);
    check(
      "the migrate-content prompt is the hosted workflow: reconnect, stored imports, background apply",
      migrate.includes("reconnect") && migrate.includes("upload: true") && migrate.includes("status: true") && !/login_status|absolute\s+path/.test(migrate),
      migrate.slice(0, 300),
    );

    const docs = await client.callTool({ name: "get_api_docs", arguments: { section: "overview" } });
    const docsText = JSON.stringify(docs.content);
    check("get_api_docs answers with no key", docs.isError !== true && docsText.includes("Writavo Content API"), docsText.slice(0, 300));

    const refused = await client.callTool({ name: "list_articles", arguments: {} });
    const refusedText = JSON.stringify(refused.content);
    check(
      "a key-requiring tool returns the actionable reconnect message",
      refused.isError === true && refusedText.includes("Reconnect Writavo") && refusedText.includes("https://mcp.writavo.com/mcp") &&
        refusedText.includes("app.writavo.com/settings/agents"),
      refusedText.slice(0, 400),
    );

    const format = await client.callTool({ name: "import_content", arguments: {} });
    const formatText = JSON.stringify(format.content);
    check(
      "import_content with no document describes the format, with no key",
      format.isError !== true && formatText.includes("writavo-import") && formatText.includes("JSON Schema"),
      formatText.slice(0, 200),
    );
    const resource = JSON.stringify(await client.readResource({ uri: "writavo://import-format" }));
    check("the import format resource reads", resource.includes("external_id") && resource.includes("json-schema.org/draft/2020-12"), resource.slice(0, 200));
    const formats = JSON.stringify(await client.readResource({ uri: "writavo://formats" }));
    check("the formats resource says to reconnect, with no key", formats.includes("Reconnect Writavo") && !formats.includes("WRITAVO_API_KEY"), formats.slice(0, 200));
    check("with no key, nothing reached the API", stub.requests.length === 0);
    await client.close();
  }

  // -- 4. the no-key experience ---------------------------------------------
  console.log("\n[ 4. The no-key experience ]");
  currentKey = null;
  stub.reset();
  const noKey = await callOperation(CTX, operation("list_articles"), {});
  check(
    "a key-requiring tool explains how to reconnect, pointing at the hosted server and never at npx",
    noKey.isError === true &&
      bodyOf(noKey).includes("app.writavo.com/settings/agents") &&
      bodyOf(noKey).includes("https://mcp.writavo.com/mcp") &&
      !bodyOf(noKey).includes("npx") &&
      !bodyOf(noKey).includes("@writavo/mcp-server"),
    bodyOf(noKey).slice(0, 200),
  );
  check("it made no request at all", stub.requests.length === 0);
  check("get_api_docs still works", !handleGetApiDocs({ section: "authentication" }).isError);
  const uploadNoKey = await handleUploadMedia(CTX, { url: "https://img.example.test/x.png" });
  check(
    "upload_media explains the same thing, and fetches nothing",
    uploadNoKey.isError === true && bodyOf(uploadNoKey).includes("Reconnect Writavo") && stub.requests.length === 0,
    bodyOf(uploadNoKey).slice(0, 200),
  );

  // -- 5. the scope probe ----------------------------------------------------
  console.log("\n[ 5. The scope probe ]");
  currentKey = PUBLISHABLE_KEY;
  stub.reset();
  const scoped = await callOperation(CTX, operation("publish_article"), { id: "00000000-0000-4000-8000-000000000000", confirm: true });
  const scopedBody = bodyOf(scoped);
  check(
    "a publishable key naming the scope it lacks, not a raw 401 or 403",
    scoped.isError === true &&
      scopedBody.includes("articles:write") &&
      !/status 40[13]|HTTP 40[13]|returned 40[13]/.test(scopedBody) &&
      scopedBody.includes("app.writavo.com/settings/api-keys"),
    scopedBody.slice(0, 300),
  );
  check("it did not send the key to be refused", stub.requests.length === 0);

  // The same code arriving from the API maps to the same answer.
  currentKey = SECRET_KEY;
  stub.reset();
  stub.respond = () => ({
    status: 403,
    body: { ok: false, error: { code: "INSUFFICIENT_SCOPE", message: "This key does not carry the scope this operation needs." } },
  });
  const apiScope = await callOperation(CTX, operation("list_media"), {});
  check(
    "a 403 from the API maps to the same actionable answer",
    apiScope.isError === true &&
      bodyOf(apiScope).includes("media:read") &&
      !/status 403|HTTP 403|returned 403/.test(bodyOf(apiScope)),
    bodyOf(apiScope).slice(0, 300),
  );

  // -- 6. the credit probe ---------------------------------------------------
  console.log("\n[ 6. The credit probe ]");
  stub.reset();
  stub.respond = () => ({
    status: 402,
    body: {
      ok: false,
      error: { code: "INSUFFICIENT_CREDITS", message: "This organisation cannot afford the next unit of work.", request_id: "req_smoke" },
    },
  });
  const credits = await callOperation(CTX, operation("trigger_pipeline_run"), { confirm: true });
  const creditsBody = bodyOf(credits);
  check(
    "an exhausted balance produces an actionable message with a billing link",
    credits.isError === true &&
      creditsBody.includes("Top up") &&
      creditsBody.includes("app.writavo.com/billing") &&
      !/\b402\b/.test(creditsBody),
    creditsBody.slice(0, 300),
  );
  check("the request carried an Idempotency-Key", stub.requests[0]?.idempotencyKey !== null);

  stub.reset();
  stub.respond = () => ({
    status: 402,
    body: { ok: false, error: { code: "NOT_ENTITLED", message: "This plan does not include AI generation." } },
  });
  const entitlement = await callOperation(CTX, operation("trigger_pipeline_run"), { confirm: true });
  check(
    "a plan failure names the plan feature",
    bodyOf(entitlement).includes("ai.article_generation") && bodyOf(entitlement).includes("app.writavo.com/billing"),
    bodyOf(entitlement).slice(0, 300),
  );

  // -- 7. the confirmation probe --------------------------------------------
  console.log("\n[ 7. The confirmation probe ]");
  stub.respond = () => ({ status: 200, body: { ok: true, data: { id: "x" } } });
  for (const tool of ["publish_article", "delete_article", "trigger_pipeline_run", "schedule_article"]) {
    stub.reset();
    const op = operation(tool);
    const unconfirmed = await callOperation(CTX, op, { id: "00000000-0000-4000-8000-000000000000", scheduled_publish_at: "2030-01-01T00:00:00Z" });
    const body = bodyOf(unconfirmed);
    check(
      `${tool} does nothing without confirm: true`,
      stub.requests.length === 0 && body.startsWith("Nothing has been done.") && body.includes("confirm: true"),
      `${stub.requests.length} request(s) reached the API. ${body.slice(0, 160)}`,
    );
  }
  stub.reset();
  const confirmed = await callOperation(CTX, operation("publish_article"), { id: "00000000-0000-4000-8000-000000000000", confirm: true });
  check(
    "and it does act once confirmed",
    stub.requests.length === 1 && confirmed.isError !== true,
    `${stub.requests.length} request(s). ${bodyOf(confirmed).slice(0, 160)}`,
  );

  // -- 8. the leak probe -----------------------------------------------------
  console.log("\n[ 8. The leak probe ]");
  const transcript: string[] = [];
  stub.reset();
  // An API that echoes the credential back in an error message is the realistic worst case, and
  // the one a client cannot control. It must not survive to the model's context or a log line.
  stub.respond = () => ({
    status: 500,
    body: { ok: false, error: { code: "INTERNAL_ERROR", message: `Upstream rejected key ${SECRET_KEY} at gateway.` } },
  });
  transcript.push(bodyOf(await callOperation(CTX, operation("list_articles"), {})));
  transcript.push(bodyOf(await callOperation(CTX, operation("get_article"), { id: "00000000-0000-4000-8000-000000000000" })));
  stub.respond = () => ({ status: 200, body: { ok: true, data: { echo: SECRET_KEY } } });
  transcript.push(bodyOf(await callOperation(CTX, operation("get_usage"), {})));
  transcript.push(redact(`a stray log line with ${SECRET_KEY} in it`));

  check(
    "no key survives in any reply, even one the API echoed back",
    !transcript.some((t) => t.includes(SECRET_KEY)),
    transcript.find((t) => t.includes(SECRET_KEY))?.slice(0, 200) ?? "",
  );
  check(
    "no wv_sk_ prefix followed by key material appears anywhere",
    !transcript.some((t) => /wv_sk_(?!REDACTED)[A-Za-z0-9]/.test(t)),
  );
  check("the request that failed still carried the key to the API", stub.requests.every((r) => r.hasAuth));

  // -- a Site in memory, behind the stub --------------------------------------
  // Enough of the API for billing and the importer to run against: taxonomy, articles with
  // external_id, idempotent creates, publish with original dates, the upload handshake.
  type Row = Record<string, unknown>;
  const site = {
    categories: [] as Row[],
    tags: [{ id: "00000000-0000-4000-8000-00000000c0c0", slug: "compost", name: "Compost" }] as Row[],
    // Already on the Site, with a bio a person wrote: the import may fill her job title, never the bio.
    authors: [{ id: "00000000-0000-4000-8000-00000000a0a0", name: "Sam Roe", slug: "sam-roe", bio: "Written by hand.", job_title: null, socials: { x: "https://x.com/samroe" }, author_type: "user" }] as Row[],
    articles: [] as Row[],
    replays: new Map<string, { status: number; body: unknown }>(),
    // The engagement and cost-history endpoints, as the API implements them (SET, not add).
    engagementDaily: new Map<string, Row>(),
    engagementPicks: new Map<string, Row>(),
    engagementCalls: 0,
    engagementOff: false,
    // POST /articles/cost-history (0138): SET per article by external_id; `bulkCostOff` is an API without the route.
    bulkCostCalls: 0,
    bulkCostOff: false,
    // What GET /ping reports this connection carries (null: every scope the importer may need).
    scopes: null as string[] | null,
    // POST /redirects/bulk (0127), SET on the old URL; to_external_id must name a Site article.
    redirects: new Map<string, Row>(),
    redirectCalls: 0,
    // 0136: content types (by api_id) and entries, as writavo-api-content answers.
    contentTypes: new Map<string, Row>(),
    entries: [] as Row[],
    entryCreates: 0,
  };
  const ok = (data: unknown, status = 200) => ({ status, body: { ok: true, data } });
  const fail = (status: number, code: string, message: string) => ({ status, body: { ok: false, error: { code, message } } });
  const project = (row: Row, fields: string | null): Row =>
    fields ? Object.fromEntries(fields.split(",").map((f) => [f, row[f] ?? null])) : row;
  const siteRespond = (req: StubRequest): { status: number; body: unknown } => {
    const url = new URL(req.path, "http://stub");
    const path = url.pathname.replace(/^\/v1/, "");
    const q = url.searchParams;
    const body = (req.body ? JSON.parse(req.body) : {}) as Row;

    if (req.method === "GET" && path === "/site") return ok({ id: "00000000-0000-4000-8000-0000000051e1", name: "Smoke Site" });
    if (req.method === "GET" && path === "/ping") {
      const all = ["articles:read", "articles:write", "taxonomy:write", "authors:write", "media:write", "engagement:write", "content_types:write", "entries:write", "meta:read"];
      return ok({ pong: true, key_kind: "secret", scopes: site.scopes ?? all });
    }
    if (req.method === "GET" && path === "/usage") {
      return ok({ plan: { key: "free", name: "Free" }, limits: [{ key: "documents", limit: 10000, used: 5 }], credits: { balance: 0 } });
    }
    if (req.method === "GET" && path === "/formats") {
      return ok({ items: [{ id: "00000000-0000-4000-8000-00000000f0f0", key: "how_to", name: "How-To", is_active: true }] });
    }
    for (const kind of ["categories", "tags", "authors"] as const) {
      if (path !== `/${kind}`) continue;
      if (req.method === "GET") return ok({ items: site[kind], next_cursor: null });
      if (req.method === "POST") {
        if ((kind !== "authors" || body.slug) && site[kind].some((r) => r.slug === body.slug)) return fail(409, "SLUG_CONFLICT", "That slug is taken.");
        const row = { id: randomUUID(), ...body };
        site[kind].push(row);
        return ok(row, 201);
      }
    }
    const term = /^\/(categories|tags)\/([^/]+)$/.exec(path);
    if (term && req.method === "PATCH") {
      const row = site[term[1] as "categories" | "tags"].find((t) => t.id === term[2]);
      if (!row) return fail(404, "NOT_FOUND", "No such term.");
      Object.assign(row, body);
      return ok(row);
    }
    const author = /^\/authors\/([^/]+)$/.exec(path);
    if (author && req.method === "PATCH") {
      const row = site.authors.find((a) => a.id === author[1]);
      if (!row) return fail(404, "NOT_FOUND", "No such author.");
      Object.assign(row, body);
      return ok(row);
    }
    if (path === "/articles" && req.method === "GET") {
      let rows = site.articles;
      if (q.get("external_id")) rows = rows.filter((a) => a.external_id === q.get("external_id"));
      if (q.get("slug")) rows = rows.filter((a) => a.slug === q.get("slug"));
      return ok({ items: rows.map((r) => project(r, q.get("fields"))), next_cursor: null });
    }
    if (path === "/articles" && req.method === "POST") {
      const replay = site.replays.get(req.idempotencyKey ?? "");
      if (replay) return replay;
      if (body.slug && site.articles.some((a) => a.slug === body.slug)) return fail(409, "SLUG_CONFLICT", "That slug is taken.");
      const row: Row = { id: randomUUID(), status: "draft", published_at: null, ...body };
      site.articles.push(row);
      const response = ok(row, 201);
      site.replays.set(req.idempotencyKey ?? "", response);
      return response;
    }
    if (path === "/articles/cost-history" && req.method === "POST" && !site.bulkCostOff) {
      site.bulkCostCalls += 1;
      const results = ((body.items ?? []) as Row[]).map((item, index) => {
        const row = site.articles.find((a) => a.external_id === item.external_id);
        if (!row) return { index, status: "not_found", error: "no article of this Site matches" };
        row.cost_history = item.entries;
        return { index, status: "written", article_id: row.id, entries: (item.entries as Row[]).length, problems: [] };
      });
      return ok({ dry_run: false, written: results.filter((r) => r.status === "written").length, not_found: results.filter((r) => r.status === "not_found").length, invalid: 0, results });
    }
    const one = /^\/articles\/([^/]+)(\/publish|\/schedule)?$/.exec(path);
    if (one) {
      const row = site.articles.find((a) => a.id === one[1]);
      if (!row) return fail(404, "NOT_FOUND", "No such article.");
      if (one[2] === "/schedule" && req.method === "POST") {
        if (row.status === "published") return fail(409, "CONFLICT", "This article is live.");
        if (!(Date.parse(String(body.scheduled_publish_at)) > Date.now())) return fail(422, "VALIDATION_FAILED", "Must be in the future.");
        row.status = "scheduled";
        row.scheduled_publish_at = body.scheduled_publish_at;
        return ok({ id: row.id, status: row.status, scheduled_publish_at: row.scheduled_publish_at });
      }
      if (one[2] && req.method === "POST") {
        row.status = "published";
        row.published_at ??= (body.published_at as string | undefined) ?? new Date().toISOString();
        if (body.content_updated_at) row.content_updated_at = body.content_updated_at;
        return ok({ id: row.id, status: row.status, published_at: row.published_at });
      }
      if (req.method === "PATCH") {
        Object.assign(row, body);
        return ok(row);
      }
      if (req.method === "GET") return ok(project(row, q.get("fields")));
    }
    if (path === "/media/upload-url" && req.method === "POST") {
      const id = randomUUID();
      return ok(
        { upload_id: id, upload_url: `https://uploads.example.test/put/${id}`, method: "PUT", headers: {}, expires_at: new Date(Date.now() + 600_000).toISOString(), max_size_bytes: 10 * 1024 * 1024 },
        201,
      );
    }
    if (path === "/media" && req.method === "POST") {
      return ok({ id: randomUUID(), bucket: "blog-images", url: `https://cdn.example.test/media/${String(body.upload_id)}.png` }, 201);
    }
    if (path === "/engagement/import" && req.method === "POST" && !site.engagementOff) {
      site.engagementCalls += 1;
      const findPost = (r: Row) => site.articles.find((a) => (r.external_id !== undefined ? a.external_id === r.external_id : a.slug === r.slug));
      const problems: Row[] = [];
      let daily = 0;
      let picks = 0;
      ((body.daily ?? []) as Row[]).forEach((r, index) => {
        const post = findPost(r);
        if (!post) return void problems.push({ section: "daily", index, error: "no such post on this Site" });
        if (body.dry_run === false) site.engagementDaily.set(`${String(post.slug)}|${String(r.day)}`, r);
        daily += 1;
      });
      ((body.reactions ?? []) as Row[]).forEach((r, index) => {
        const post = findPost(r);
        if (!post) return void problems.push({ section: "reactions", index, error: "no such post on this Site" });
        if (body.dry_run === false) site.engagementPicks.set(`${String(post.slug)}|${String(r.visitor_id)}`, r);
        picks += 1;
      });
      return ok({ dry_run: body.dry_run !== false, written: { daily, share_rows: daily, picks }, posts: [], problems });
    }
    if (path === "/redirects/bulk" && req.method === "POST") {
      site.redirectCalls += 1;
      const problems: Row[] = [];
      let created = 0;
      let unchanged = 0;
      ((body.redirects ?? []) as Row[]).forEach((r, index) => {
        if (r.to_external_id !== undefined && !site.articles.some((a) => a.external_id === r.to_external_id)) {
          return void problems.push({ index, error: "no article with this external_id on this Site" });
        }
        const k = String(r.from);
        if (site.redirects.has(k) && JSON.stringify(site.redirects.get(k)) === JSON.stringify(r)) unchanged += 1;
        else created += 1;
        if (body.dry_run === false) site.redirects.set(k, r);
      });
      return ok({ dry_run: body.dry_run !== false, written: { created, updated: 0, unchanged }, items: [], problems });
    }
    const costs = /^\/articles\/([^/]+)\/cost-history$/.exec(path);
    if (costs && req.method === "POST") {
      const row = site.articles.find((a) => a.id === costs[1]);
      if (!row) return fail(404, "NOT_FOUND", "No such article.");
      row.cost_history = body.entries;
      const total = ((body.entries ?? []) as Row[]).reduce((n, e) => n + Number(e.cost_usd), 0);
      return ok({ article_id: row.id, imported_total_usd: total, entries: body.entries, problems: [] });
    }
    if (path === "/content-types/apply" && req.method === "POST") {
      const types = (body.types ?? []) as Row[];
      const plan = {
        create: types.filter((t) => !site.contentTypes.has(String(t.api_id))).map((t) => t.api_id),
        update: [], delete: [],
        unchanged: types.filter((t) => site.contentTypes.has(String(t.api_id))).map((t) => t.api_id),
      };
      if (!body.dry_run) for (const t of types) site.contentTypes.set(String(t.api_id), { ...t, kind: t.kind ?? "collection" });
      return ok({ dry_run: !!body.dry_run, ok: true, plan, errors: [] });
    }
    if (path === "/content-types" && req.method === "GET") return ok({ items: [...site.contentTypes.values()] });
    const ent = /^\/entries\/([a-z][a-z0-9_]*)(?:\/([^/]+))?(\/publish|\/schedule|\/schedule-unpublish)?$/.exec(path);
    if (ent) {
      const [, type, id, verb] = ent;
      if (!site.contentTypes.has(type!)) return fail(404, "NOT_FOUND", "No such object.");
      if (!id && req.method === "GET") {
        const items = site.entries.filter((e) => e.type === type && (!q.get("external_id") || e.external_id === q.get("external_id")));
        return ok({ items, next_cursor: null });
      }
      if (!id && req.method === "POST") {
        site.entryCreates += 1;
        const row = { id: randomUUID(), type, status: "draft", external_id: body.external_id ?? null, slug: body.slug ?? null, data: body.data ?? {} };
        site.entries.push(row);
        return ok(row, 201);
      }
      const row = site.entries.find((e) => e.id === id && e.type === type);
      if (!row) return fail(404, "NOT_FOUND", "No such object.");
      if (verb === "/publish") row.status = "published";
      else if (verb === "/schedule") row.status = "scheduled";
      else if (verb === "/schedule-unpublish") row.unpublish_at = body.at;
      else if (req.method === "PATCH") {
        row.data = body.replace ? body.data : { ...(row.data as Row), ...(body.data as Row) };
        if ("slug" in body) row.slug = body.slug;
      }
      return ok(row);
    }
    return fail(404, "NOT_FOUND", `The stub has no route for ${req.method} ${path}.`);
  };

  // Image hosts and presigned storage, answered in process. Everything else, the loopback stub
  // included, goes to the real fetch.
  const realFetch = globalThis.fetch;
  const presignedPuts: string[] = [];
  const imageFetches: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(href).hostname;
    if (host === "uploads.example.test") {
      presignedPuts.push(href);
      return new Response(null, { status: 200 });
    }
    if (host === "img.example.test") {
      imageFetches.push(href);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
      return new Response(png, { status: 200, headers: { "content-type": href.endsWith(".jpg") ? "image/jpeg" : "image/png" } });
    }
    if (host.endsWith(".example.test")) return new Response("not here", { status: 404 });
    return realFetch(input, init);
  }) as typeof fetch;

  const waitUntil = async (condition: () => boolean, timeoutMs = 15_000): Promise<boolean> => {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return true;
  };
  const writes = () => stub.requests.filter((r) => r.method !== "GET");

  // -- 12. client names -------------------------------------------------------
  console.log("\n[ 12. Client names ]");
  stub.respond = siteRespond;
  // The Worker names a key after the connected client (Addendum B): a registered OAuth client's
  // raw name becomes the one a person sees in Settings > API keys and Settings > AI agents.
  {
    const { friendlyClientName } = await import("../src/core/index.js");
    const cases: [string | undefined, string][] = [
      ["claude-code", "Claude Code"],
      ["codex-mcp-client", "Codex"],
      ["Codex", "Codex"],
      ["cursor-vscode", "Cursor"],
      ["Visual Studio Code", "VS Code"],
      ["vscode-insiders", "VS Code"],
      ["claude-ai", "Claude"],
      ["windsurf-client", "Windsurf"],
      ["Zed", "Zed"],
      ["my-agent", "my-agent"],
      ["  weird\u0000\u00e9name\n", "weird name"],
      ["x".repeat(80), "x".repeat(60)],
      ["", "AI assistant"],
      ["\u00e9\u00e9", "AI assistant"],
      [undefined, "AI assistant"],
    ];
    const wrong = cases.filter(([raw, want]) => friendlyClientName(raw) !== want);
    check(
      `friendlyClientName maps ${cases.length} client names, sanitises and falls back`,
      wrong.length === 0,
      wrong.map(([raw, want]) => `${JSON.stringify(raw)} -> ${JSON.stringify(friendlyClientName(raw))}, wanted ${want}`).join("; "),
    );
  }

  // -- 13. the plan purchase link --------------------------------------------
  console.log("\n[ 13. The plan purchase link ]");
  currentKey = null;
  stub.reset();
  const planNoKey = bodyOf(await handleStartPlanPurchase(CTX, { plan: "growth", interval: "year" }));
  check(
    "it returns the billing deep link with the plan and interval",
    planNoKey.includes("https://app.writavo.com/billing?plan=growth&interval=year"),
    planNoKey.slice(0, 200),
  );
  check(
    "it says payment happens on Stripe, not in the chat, and that the CMS needs no plan",
    planNoKey.includes("Stripe") && planNoKey.includes("never happens in this chat") && planNoKey.includes("pay-as-you-go") && planNoKey.includes("needs no plan"),
  );
  check("it says to confirm with get_usage afterwards", planNoKey.includes("get_usage"));
  check("with no key it makes no request", stub.requests.length === 0);
  currentKey = SECRET_KEY;
  const planWithKey = bodyOf(await handleStartPlanPurchase(CTX, {}));
  check(
    "with a key it names the current plan",
    planWithKey.includes("Current plan: Free") && planWithKey.includes("https://app.writavo.com/billing\n"),
    planWithKey.slice(0, 300),
  );

  // -- 14. the importer ------------------------------------------------------
  console.log("\n[ 14. The importer ]");
  check("the sample document is valid against the format", ImportDocumentSchema.safeParse(IMPORT_SAMPLE).success);
  const jsonSchema = importFormatJsonSchema() as { required?: string[]; properties?: Record<string, unknown>; $defs?: unknown };
  check(
    "the JSON Schema is emitted from the zod definition, with the required fields",
    JSON.stringify(jsonSchema.required) === JSON.stringify(["format", "version", "articles"]) &&
      JSON.stringify(jsonSchema).includes('"external_id"') &&
      JSON.stringify(jsonSchema).includes('"additionalProperties":false'),
  );

  // Every import runs as the hosted server runs it: a stored import (an import job) on a store
  // scoped to this connection, sent as data once and then continued with just its import_id.
  const importJobs = memStore("g:key-import");
  const importIdOf = (reply: string) => /imp_[A-Za-z0-9_-]{22}/.exec(reply)?.[0] ?? "";
  const EM = "\u2014";
  const firstContent = `Intro ${EM} kept exactly as written, "quotes" and all.\n\n![A kit](https://img.example.test/a.png)\n\n![Old](http://insecure.example.test/b.png "legacy")\n\nThe end.`;
  const fixture = {
    format: "writavo-import",
    version: 1,
    authors: [
      {
        ref: "jane",
        name: "Jane Doe",
        slug: "jane-doe",
        avatar_url: "https://img.example.test/jane.png",
        job_title: "Head gardener",
        socials: { linkedin: "https://www.linkedin.com/in/janedoe" },
        author_type: "co-founder",
      },
      { ref: "sam", name: "Sam Roe", slug: "sam-roe", bio: "From the old blog.", job_title: "Editor", socials: { x: "https://x.com/other", github: "https://github.com/samroe" }, author_type: "admin" },
    ],
    categories: [{ slug: "guides", name: "Guides" }],
    tags: [
      { slug: "soil", name: "Soil" },
      { slug: "compost", name: "Compost" },
    ],
    articles: [
      {
        external_id: "blog:1",
        status: "published",
        title: "Testing soil",
        slug: "testing-soil",
        content: firstContent,
        featured_image: { url: "https://img.example.test/hero.jpg", alt: "Soil" },
        author: "jane",
        category: "guides",
        tags: ["soil", "compost"],
        published_at: "2021-03-04T09:30:00Z",
        content_updated_at: "2022-01-10T12:00:00Z",
      },
      { external_id: "blog:2", status: "draft", title: "Winter notes", content: "Unfinished.", author: "jane" },
      {
        external_id: "blog:3",
        status: "published",
        title: "Building a bed",
        slug: "building-a-bed",
        content: "Step by step.",
        featured_image: { url: "https://img.example.test/hero.jpg" },
        format: "how_to",
        published_at: "2019-05-01T08:00:00+02:00",
      },
    ],
  };
  const importTranscript: string[] = [];
  const importCall = async (args: Record<string, unknown>) => {
    const reply = bodyOf(await handleImportContent(CTX, args, importJobs));
    importTranscript.push(reply);
    return reply;
  };

  // Validation: every problem surfaces against its own external_id, and nothing is written.
  const badDoc = {
    format: "writavo-import",
    version: 1,
    articles: [
      { external_id: "bad:1", status: "published", title: "No date", slug: "no-date", content: "x" },
      { external_id: "bad:2", status: "draft", slug: "Bad Slug" },
      { external_id: "bad:3", status: "draft", category: "nope" },
      { external_id: "bad:4", status: "draft", body: "misnamed" },
      { external_id: "bad:5", status: "published", title: "Later", slug: "later", content: "x", published_at: "2999-01-01T00:00:00Z" },
      { external_id: "good:1", status: "draft", title: "Fine" },
    ],
  };
  stub.reset();
  const invalid = await importCall({ data: badDoc });
  const badImportId = importIdOf(invalid);
  check(
    "a dry run reports each problem against its external_id",
    ["bad:1", "bad:2", "bad:3", "bad:4", "bad:5"].every((id) => invalid.includes(id)) && !/good:1 \(/.test(invalid),
    invalid.slice(0, 600),
  );
  check(
    "the problems say what is wrong",
    invalid.includes("published_at: is required") &&
      invalid.includes("lowercase letters") &&
      invalid.includes('"nope" is not in categories[]') &&
      invalid.includes('Unrecognized key: "body"') &&
      invalid.includes("in the future"),
    invalid.slice(0, 900),
  );
  check("a dry run writes nothing to the Site", writes().length === 0, writes().map((r) => `${r.method} ${r.path}`).join(", "));
  check(
    "a dry run keeps the document as an import, and records no progress",
    badImportId !== "" && jobRows.get(badImportId)?.doc !== null && jobRows.get(badImportId)?.progress === null,
    invalid.slice(0, 200),
  );

  stub.reset();
  const dry = await importCall({ data: fixture });
  const fixtureId = importIdOf(dry);
  check(
    "a clean dry run counts what it would do",
    dry.includes("Nothing was written") && dry.includes("- create: 3") && dry.includes("to publish with their original dates: 2"),
    dry.slice(0, 700),
  );
  check(
    "it counts the images to copy once each, and the one that is not https",
    dry.includes("Images to copy into the media library: 3.") && dry.includes("Not https, so kept at their original URLs: 1."),
    dry.slice(0, 900),
  );
  check("it reads the document allowance", dry.includes("Documents: 5 of 10000"));
  check(
    "it names the next call by import_id, with confirm because it publishes",
    dry.includes(`"import_id":"${fixtureId}"`) && dry.includes('"dry_run":false') && dry.includes('"confirm":true'),
    dry.slice(-600),
  );
  check("and it wrote nothing, not even progress", writes().length === 0 && jobRows.get(fixtureId)?.progress === null);

  stub.reset();
  const unconfirmed = await importCall({ import_id: fixtureId, dry_run: false });
  check(
    "an import that publishes does nothing without confirm: true",
    unconfirmed.startsWith("Nothing has been done.") && writes().length === 0,
    unconfirmed.slice(0, 200),
  );

  stub.reset();
  const applied = await importCall({ import_id: fixtureId, dry_run: false, confirm: true });
  check("the import, named by its import_id alone, completes in one call", applied.includes("Import complete"), applied.slice(0, 600));
  const posts = (suffix: string) => writes().filter((r) => r.method === "POST" && r.path.replace(/\?.*$/, "").endsWith(suffix));
  check("missing taxonomy is created, existing taxonomy is matched", posts("/categories").length === 1 && posts("/tags").length === 1);
  const authorBody = JSON.parse(posts("/authors")[0]?.body ?? "{}") as Row;
  check(
    "the author is created as a real person, with a re-hosted avatar",
    authorBody.is_ai_generated === false && String(authorBody.avatar_url).startsWith("https://cdn.example.test/"),
    JSON.stringify(authorBody),
  );
  check(
    "the author keeps its slug, job title, socials and byline type",
    posts("/authors").length === 1 &&
      authorBody.slug === "jane-doe" &&
      authorBody.job_title === "Head gardener" &&
      JSON.stringify(authorBody.socials) === JSON.stringify({ linkedin: "https://www.linkedin.com/in/janedoe" }) &&
      authorBody.author_type === "co-founder",
    JSON.stringify(authorBody),
  );
  const authorFills = writes().filter((r) => r.method === "PATCH" && r.path.includes("/authors/"));
  const fillBody = JSON.parse(authorFills[0]?.body ?? "{}") as Row;
  check(
    "an author already on the Site gains only the fields it had empty",
    authorFills.length === 1 &&
      fillBody.job_title === "Editor" &&
      fillBody.author_type === "admin" &&
      !("bio" in fillBody) &&
      !("slug" in fillBody) &&
      JSON.stringify(fillBody.socials) === JSON.stringify({ x: "https://x.com/samroe", github: "https://github.com/samroe" }),
    JSON.stringify(fillBody),
  );
  check(
    "each image is uploaded once, through the whole handshake",
    posts("/media/upload-url").length === 3 && posts("/media").length === 3 && presignedPuts.length === 3 && imageFetches.length === 3,
    `${posts("/media/upload-url").length} reservations, ${presignedPuts.length} PUTs, ${imageFetches.length} fetches`,
  );
  const articleCreates = posts("/articles");
  check(
    "three articles are created, each with a derived Idempotency-Key",
    articleCreates.length === 3 && articleCreates.every((r) => /^import-[0-9a-f]{64}$/.test(r.idempotencyKey ?? "")),
  );
  const byExternal = (id: string) => site.articles.find((a) => a.external_id === id) ?? {};
  const first = byExternal("blog:1");
  const firstBody = String(first.content ?? "");
  check(
    "the inline image URL is rewritten and nothing else in the content changes",
    firstBody.includes("https://cdn.example.test/media/") &&
      !firstBody.includes("https://img.example.test/a.png") &&
      firstBody.replace(/https:\/\/cdn\.example\.test\/media\/[^)\s]+/, "https://img.example.test/a.png") === firstContent,
    firstBody.slice(0, 300),
  );
  check("an em-dash in the customer's prose is kept as written", firstBody.includes(EM));
  check("a non-https image keeps its URL", firstBody.includes('](http://insecure.example.test/b.png "legacy")'));
  check("the featured image is re-hosted", String(first.featured_image_url).startsWith("https://cdn.example.test/"));
  check("the featured image's alt is sent as the article's featured_image_alt", first.featured_image_alt === "Soil", String(first.featured_image_alt));
  check(
    "a post live at the source carries its original dates on the article, for a first publish from any path",
    first.original_published_at === "2021-03-04T09:30:00Z" && first.original_content_updated_at === "2022-01-10T12:00:00Z" &&
      byExternal("blog:2").original_published_at === undefined,
    `${String(first.original_published_at)} / ${String(first.original_content_updated_at)}`,
  );
  check(
    "references resolve to the Site's ids",
    first.category_id === site.categories[0]?.id &&
      first.author_id === site.authors.find((a) => a.name === "Jane Doe")?.id &&
      JSON.stringify(first.tag_ids) === JSON.stringify([site.tags.find((t) => t.slug === "soil")?.id, "00000000-0000-4000-8000-00000000c0c0"]),
  );
  check("the format key resolves to its id", byExternal("blog:3").format_id === "00000000-0000-4000-8000-00000000f0f0");
  const publishes = writes().filter((r) => r.path.endsWith("/publish"));
  const firstPublish = JSON.parse(publishes.find((r) => r.path.includes(String(first.id)))?.body ?? "{}") as Row;
  check(
    "published articles are published with their original dates",
    publishes.length === 2 && firstPublish.published_at === "2021-03-04T09:30:00Z" && firstPublish.content_updated_at === "2022-01-10T12:00:00Z",
    JSON.stringify(firstPublish),
  );
  check(
    "they are live with those dates, and the draft stays a draft",
    first.status === "published" && first.published_at === "2021-03-04T09:30:00Z" && byExternal("blog:2").status === "draft",
  );
  check("progress is kept with the import on the server", typeof jobRows.get(fixtureId)?.progress === "string");

  stub.reset();
  const rerun = await importCall({ import_id: fixtureId, dry_run: false, confirm: true });
  check(
    "running it again is a no-op",
    rerun.includes("Import complete") && writes().length === 0 && site.articles.length === 3,
    `${writes().length} writes: ${writes().map((r) => `${r.method} ${r.path}`).join(", ")}`,
  );

  // A correction is sent as a part with the import_id: same external_id replaces the stored entry.
  const revised = { ...fixture.articles[1]!, title: "Winter notes, revised" };
  stub.reset();
  const updated = await importCall({ data: { format: "writavo-import", version: 1, articles: [revised] }, import_id: fixtureId, dry_run: false, confirm: true });
  const draft = byExternal("blog:2");
  check(
    "a changed article is updated in place by external_id, not duplicated",
    writes().length === 1 && writes()[0]?.method === "PATCH" && writes()[0]?.path.endsWith(`/articles/${String(draft.id)}`) &&
      draft.title === "Winter notes, revised" && site.articles.length === 3,
    `${writes().map((r) => `${r.method} ${r.path}`).join(", ")} ${updated.slice(0, 200)}`,
  );
  check(
    "an article this import created still counts as created after an update",
    updated.includes("Across the whole import: created 3, updated 0"),
    updated.slice(0, 400),
  );
  const storedTitles = (JSON.parse(jobRows.get(fixtureId)?.doc ?? "{}") as { articles?: { external_id: string; title?: string }[] }).articles ?? [];
  check(
    "the stored document now holds the corrected entry in place, not a second copy",
    storedTitles.length === 3 && storedTitles.find((a) => a.external_id === "blog:2")?.title === "Winter notes, revised",
    JSON.stringify(storedTitles.map((a) => a.external_id)),
  );

  // retry_failed: an article skipped for a slug another article owns stays skipped until asked.
  site.articles.push({ id: randomUUID(), slug: "taken-slug", title: "Someone else's", status: "draft", published_at: null });
  const retryDoc = {
    format: "writavo-import",
    version: 1,
    articles: [
      { external_id: "retry:1", status: "draft", title: "Wants a taken slug", slug: "taken-slug", content: "Mine." },
      { external_id: "retry:2", status: "draft", title: "Fine", content: "Also mine." },
    ],
  };
  const retryDry = await importCall({ data: retryDoc });
  const retryId = importIdOf(retryDry);
  stub.reset();
  const skippedRun = await importCall({ import_id: retryId, dry_run: false });
  check(
    "an article whose slug another article owns is skipped, with the owner named and retry_failed suggested",
    skippedRun.includes("retry:1") && skippedRun.includes('slug "taken-slug" is already used') && skippedRun.includes("retry_failed: true") &&
      Boolean(byExternal("retry:2").id) && !byExternal("retry:1").id,
    skippedRun.slice(0, 900),
  );
  site.articles = site.articles.filter((a) => a.slug !== "taken-slug" || a.external_id === "retry:1");
  stub.reset();
  const withoutRetry = await importCall({ import_id: retryId, dry_run: false });
  check(
    "continuing without retry_failed leaves a skipped article alone",
    writes().filter((r) => r.method === "POST" && r.path.replace(/\?.*$/, "").endsWith("/articles")).length === 0 && !byExternal("retry:1").id,
    withoutRetry.slice(0, 300),
  );
  stub.reset();
  const retried = await importCall({ import_id: retryId, dry_run: false, retry_failed: true });
  check(
    "retry_failed: true tries the skipped article again once the slug is free, and only that one",
    retried.includes("Import complete") && byExternal("retry:1").slug === "taken-slug" &&
      writes().filter((r) => r.method === "POST" && r.path.replace(/\?.*$/, "").endsWith("/articles")).length === 1,
    retried.slice(0, 600),
  );
  check(
    "no import reply ever carries the key",
    !importTranscript.some((t) => t.includes(SECRET_KEY) || /wv_sk_(?!REDACTED)[A-Za-z0-9_-]{20,}/.test(t)),
  );

  // -- 14b. Stored imports (the hosted server's import jobs) ------------------
  console.log("\n[ 14b. Stored imports: one-pass dry run, import_id, parts, upload links ]");
  {
    const { checkDocument } = await import("../src/import/validate.js");
    const { mergeImportDocuments, IMPORT_ID_RE } = await import("../src/import/jobs.js");

    // One pass: a bad author, a bad tag and bad articles are all reported together.
    const onePass = checkDocument({
      format: "writavo-import",
      version: 1,
      authors: [{ ref: "ok", name: "Fine Author" }, { ref: "broken", name: "Broken", socials: { myspace: "https://myspace.test/x" } }],
      tags: [{ slug: "Not A Slug", name: "Bad" }, { slug: "good", name: "Good" }],
      articles: [
        { external_id: "p:1", status: "published", title: "No date", slug: "no-date", content: "x", author: "broken" },
        { external_id: "p:2", status: "draft", title: "Fine", author: "ok", tags: ["good"] },
      ],
    });
    check(
      "a document with top-level problems still has every article checked (one pass)",
      onePass.envelope !== null && onePass.envelopeErrors.length === 2 && onePass.items.length === 2 &&
        onePass.items[0]!.errors.some((e) => e.includes("published_at")) && onePass.items[1]!.errors.length === 0,
      JSON.stringify({ env: onePass.envelopeErrors, items: onePass.items.map((i) => i.errors) }),
    );
    check(
      "an article naming an author whose own entry is broken is not reported twice",
      !onePass.items[0]!.errors.some((e) => e.includes("authors[].ref")),
      onePass.items[0]!.errors.join("; "),
    );
    check("salvaging keeps only the entries that parse", onePass.envelope?.authors?.length === 1 && onePass.envelope?.tags?.length === 1);

    const merged = mergeImportDocuments(
      { format: "writavo-import", version: 1, authors: [{ ref: "a", name: "A" }], articles: [{ external_id: "x:1", title: "old" }, { external_id: "x:2" }] },
      { authors: [{ ref: "a", name: "A2" }, { ref: "b", name: "B" }], articles: [{ external_id: "x:1", title: "new" }, { external_id: "x:3" }] },
    ) as { authors: { name: string }[]; articles: { external_id: string; title?: string }[] };
    check(
      "parts merge on their keys: a repeated key replaces in place, a new one is appended",
      merged.authors.map((a) => a.name).join() === "A2,B" && merged.articles.map((a) => a.external_id).join() === "x:1,x:2,x:3" && merged.articles[0]!.title === "new",
      JSON.stringify(merged),
    );

    const jobs = memStore("g:key-1");
    const jobDoc = {
      format: "writavo-import",
      version: 1,
      categories: [{ slug: "guides", name: "Guides" }],
      articles: [
        { external_id: "job:1", status: "draft", title: "Stored one", content: "One." },
        { external_id: "job:2", status: "draft", title: "Stored two", content: "Two." },
      ],
    };

    const hosted = importContentTool(jobs);
    const props = Object.keys(hosted.inputSchema);
    check("with job support, import_content takes url, upload and import_id, and no path", ["url", "upload", "import_id"].every((k) => props.includes(k)) && !props.includes("path"));

    stub.reset();
    const firstDry = bodyOf(await handleImportContent(CTX, { data: jobDoc }, jobs));
    const importId = /imp_[A-Za-z0-9_-]{22}/.exec(firstDry)?.[0] ?? "";
    check(
      "an inline dry run is stored as an import and names its import_id in the next call",
      IMPORT_ID_RE.test(importId) && firstDry.includes("Nothing was written") && firstDry.includes(`"import_id":"${importId}"`) && writes().length === 0,
      firstDry.slice(0, 800),
    );

    const part2 = { format: "writavo-import", version: 1, articles: [{ external_id: "job:3", status: "draft", title: "Stored three", content: "Three." }] };
    stub.reset();
    const withPart = bodyOf(await handleImportContent(CTX, { data: part2, import_id: importId }, jobs));
    check("a second part with the import_id is added to the stored document", withPart.includes("- create: 3"), withPart.slice(0, 600));

    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: importId, dry_run: false }, jobs));
    check(
      "applying by import_id alone imports the stored document and keeps progress on the server",
      applied.includes("Import complete") && ["job:1", "job:2", "job:3"].every((id) => byExternal(id).id) && jobRows.get(importId)?.progress !== null,
      applied.slice(0, 600),
    );
    check(
      "an apply reply says where its time went: phases, then API requests by kind with their average",
      /Where this call's time went: .*checks [0-9.]+ s, Site reads [0-9.]+ s/.test(applied) && /API: \d+ writes [0-9.]+ s \([0-9.]+ s each\)/.test(applied),
      applied.slice(-400),
    );
    check(
      "the dry run's estimate is time-based: it names the per-call working time",
      firstDry.includes("each works for about 18 seconds") && firstDry.includes("where its time went"),
      firstDry.slice(0, 1200),
    );
    stub.reset();
    const again = bodyOf(await handleImportContent(CTX, { import_id: importId, dry_run: false }, jobs));
    check("continuing a finished import writes nothing", again.includes("Import complete") && writes().length === 0, again.slice(0, 300));

    const other = memStore("g:key-2");
    const foreign = await handleImportContent(CTX, { import_id: importId }, other);
    check("another connection's import_id answers as if it did not exist", foreign.isError === true && bodyOf(foreign).includes(`There is no import ${importId}`));

    jobRows.get(importId)!.lease = { holder: "someone-else", until: Date.now() + 60_000 };
    const busy = bodyOf(await handleImportContent(CTX, { import_id: importId, dry_run: false }, jobs));
    check("a second call while another holds the import starts nothing, and says when the hold ends", busy.includes("still running") && /hold ends by \d{4}-\d\d-\d\dT/.test(busy), busy.slice(0, 300));
    delete jobRows.get(importId)!.lease;

    // A request budget (a free Cloudflare plan's 50 per invocation): the call stops cleanly before
    // the cap, records what it did, and the next call carries on until everything is done.
    const budgetDoc = {
      format: "writavo-import",
      version: 1,
      articles: Array.from({ length: 6 }, (_, i) => ({ external_id: `budget:${i}`, status: "draft", title: `Budget ${i}`, content: "x" })),
    };
    stub.reset();
    const tightFirst = bodyOf(await handleImportContent(CTX, { data: budgetDoc, dry_run: false }, jobs, { workMs: 18_000, graceMs: 7_000, maxRequests: 14 }));
    const budgetId = /imp_[A-Za-z0-9_-]{22}/.exec(tightFirst)?.[0] ?? "";
    const firstCallRequests = stub.requests.length;
    let rounds = 1;
    let tightLast = tightFirst;
    while (!tightLast.includes("Import complete") && rounds < 10) {
      tightLast = bodyOf(await handleImportContent(CTX, { import_id: budgetId, dry_run: false }, jobs, { workMs: 18_000, graceMs: 7_000, maxRequests: 14 }));
      rounds += 1;
    }
    check(
      "a request budget stops a call cleanly before its cap, and later calls finish the import",
      tightFirst.includes("request budget ran out") && firstCallRequests <= 14 && tightLast.includes("Import complete") && rounds > 1 &&
        Array.from({ length: 6 }, (_, i) => byExternal(`budget:${i}`).id).every(Boolean),
      `${firstCallRequests} requests, ${rounds} calls: ${tightFirst.slice(0, 300)}`,
    );

    const link = bodyOf(await handleImportContent(CTX, { upload: true }, jobs));
    const uploadId = /imp_[A-Za-z0-9_-]{22}/.exec(link)?.[0] ?? "";
    check(
      "upload: true returns a curl command with a one-time bearer, and nothing is checked yet",
      link.includes("curl") && link.includes("Authorization: Bearer") && link.includes(`/imports/${uploadId}`) && link.includes("--data-binary @"),
      link.slice(0, 500),
    );
    const early = await handleImportContent(CTX, { import_id: uploadId }, jobs);
    check("an import that is still waiting for its upload says so", early.isError === true && bodyOf(early).includes("Nothing has been uploaded"));

    const notHttps = await handleImportContent(CTX, { url: "http://example.test/import.json" }, jobs);
    check("url must be https, and nothing is stored for a refused fetch", notHttps.isError === true && bodyOf(notHttps).includes("https"));
    const both = await handleImportContent(CTX, { data: jobDoc, url: "https://example.test/x.json" }, jobs);
    check("data and url together are refused", both.isError === true && bodyOf(both).includes("not several"));

    stub.reset();
    const topLevelBad = { ...jobDoc, tags: [{ slug: "Bad Slug", name: "x" }], articles: [...jobDoc.articles, { external_id: "job:9", status: "published", title: "t", slug: "t", content: "c" }] };
    const onePassDry = bodyOf(await handleImportContent(CTX, { data: topLevelBad }, jobs));
    check(
      "the dry run reports top-level and article problems together, and refuses to apply until fixed",
      onePassDry.includes("top level") && onePassDry.includes("tags[0].slug") && onePassDry.includes("job:9") && writes().length === 0,
      onePassDry.slice(0, 900),
    );
    const badId = /imp_[A-Za-z0-9_-]{22}/.exec(onePassDry)?.[0] ?? "";
    const refusedApply = await handleImportContent(CTX, { import_id: badId, dry_run: false }, jobs);
    check("an apply with top-level problems writes nothing", refusedApply.isError === true && writes().length === 0, bodyOf(refusedApply).slice(0, 300));
  }

  // -- 14d. Background status replies and date precision ------------------------
  console.log("\n[ 14d. Background status replies never tell an agent to apply again; date precision is reported ]");
  {
    const { backgroundStatusText } = await import("../src/tools/import-content.js");
    const batch = [
      "Imported a batch into the Site \"X\". 10 of 106 articles are done and 96 remain.",
      "",
      "Progress is saved in the import job imp_x.",
      "Next: call import_content again with the same arguments to continue:",
      'import_content {"import_id":"imp_AAAAAAAAAAAAAAAAAAAAAA","dry_run":false}',
      "",
      "Where this call's time went: checks 0.1 s.",
    ].join("\n");
    const progress = { articles_total: 106, articles_done: 10, articles_failed: 0, articles_skipped: 0, images_copied: 30, images_failed: 0, categories_created: 8, tags_created: 39, authors_created: 2 };
    const reply = backgroundStatusText("imp_AAAAAAAAAAAAAAAAAAAAAA", {
      state: "running", started_at: "2026-09-28T15:00:00Z", updated_at: "2026-09-28T15:01:00Z", finished_at: null, batches: 3, error: null, last_report: batch, progress,
    });
    check(
      "a running import's status quotes the last batch without its apply-again instructions",
      reply.includes("Imported a batch") && reply.includes("time went") && !reply.includes("Next: call import_content again") && !/"dry_run":false/.test(reply) && reply.includes("Do not start it again"),
      reply,
    );

    const preciseDoc = {
      format: "writavo-import",
      version: 1,
      articles: [{ external_id: "precise:1", status: "published", title: "Precise", slug: "precise-dates", content: "x", published_at: "2021-03-04T16:33:34.967476Z" }],
    };
    stub.reset();
    const preciseDry = bodyOf(await handleImportContent(CTX, { data: preciseDoc }, memStore("g:key-precise")));
    check("the dry run says when source dates are more precise than a millisecond", preciseDry.includes("more than millisecond precision") && preciseDry.includes("34.967476"), preciseDry.slice(0, 900));
  }

  // -- 14e. The inline limit a free-plan Worker can parse ------------------------
  console.log("\n[ 14e. Inline parts are small; bigger documents go by upload or url ]");
  {
    const big = {
      format: "writavo-import",
      version: 1,
      articles: [{ external_id: "big:1", status: "draft", title: "Big", content: "x".repeat(600 * 1024) }],
    };
    stub.reset();
    const refused = await handleImportContent(CTX, { data: big }, memStore("g:key-big"));
    check(
      "an inline part over 512 KB is refused before anything is stored, pointing to upload or url",
      refused.isError === true && bodyOf(refused).includes("512 KB") && bodyOf(refused).includes("upload: true") && writes().length === 0,
      bodyOf(refused).slice(0, 300),
    );
    const described = importContentTool(memStore("g:key-big")).description;
    check("the tool description puts upload first and keeps inline data for small documents", described.indexOf("upload: true") < described.indexOf("Inline data") && described.includes("512 KB"), described.slice(0, 400));
    const withRunner = importContentTool({ ...memStore("g:key-desc"), startBackground: async () => { throw new Error("unused"); }, status: async () => null, cancel: async () => null });
    const runnerText = `${withRunner.description} ${String((withRunner.inputSchema.batch_size as { description?: string }).description ?? "")}`;
    check(
      "with a background runner, nothing in the tool tells an agent to apply again to continue",
      !/as much as fits in one call|says what is left|35 seconds/.test(runnerText) && runnerText.includes("call it once, then only check status"),
      runnerText.slice(0, 600),
    );
  }

  // -- 14f. Engagement history and article cost history ---------------------------
  console.log("\n[ 14f. Engagement history and cost history travel with the import ]");
  {
    currentKey = SECRET_KEY;
    const doc = {
      format: "writavo-import",
      version: 1,
      articles: [
        { external_id: "eng:1", status: "draft", title: "Engaged one", slug: "engaged-one", content: "x", cost_history: [{ cost_usd: 0.42, stage: "generate", provider: "openai", occurred_on: "2026-05-10" }] },
        { external_id: "eng:2", status: "draft", title: "Engaged two", slug: "engaged-two", content: "y" },
      ],
      engagement: {
        daily: [
          { external_id: "eng:1", day: "2026-05-10", views: 12, reactions: { useful: 2, loved: 1 }, shares: { x: 1 } },
          { slug: "engaged-two", day: "2026-05-11", views: 5 },
          { external_id: "eng:missing", day: "2026-05-11", views: 9 },
          { external_id: "eng:1", day: "2999-01-01", views: 1 },
        ],
        reactions: [{ external_id: "eng:1", visitor_id: "anon-123", reaction: "loved", set_at: "2026-05-10T10:00:00Z" }],
      },
    };
    const store = memStore("g:key-engagement");
    stub.reset();
    const dry = bodyOf(await handleImportContent(CTX, { data: doc }, store));
    const engId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "the dry run summarises the engagement section, flags a row for no post and a future day, and sends nothing",
      dry.includes("Engagement history: 3 daily rows and 1 visitor reactions for 3 posts") && dry.includes("views 26") &&
        dry.includes("name a post that is neither in this document nor on the Site") && dry.includes("not a finished day") && site.engagementCalls === 0,
      dry.slice(dry.indexOf("Engagement"), dry.indexOf("Engagement") + 700),
    );
    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: engId, dry_run: false, background: false }, store));
    const one = byExternal("eng:1");
    check(
      "an apply writes the articles, then sends the engagement history once, keyed by post and day",
      applied.includes("Import complete") && applied.includes("Engagement history: delivered") && site.engagementCalls === 2 &&
        site.engagementDaily.has("engaged-one|2026-05-10") && site.engagementDaily.has("engaged-two|2026-05-11") && site.engagementPicks.has("engaged-one|anon-123"),
      applied.slice(0, 1200),
    );
    check("each article's cost history is sent to its own record, apart from Writavo's costs", Array.isArray(one.cost_history) && (one.cost_history as Row[])[0]?.cost_usd === 0.42);
    const callsBefore = site.engagementCalls;
    const again = bodyOf(await handleImportContent(CTX, { import_id: engId, dry_run: false, background: false }, store));
    check("running it again sends nothing new (the section is already delivered)", again.includes("Import complete") && site.engagementCalls === callsBefore, again.slice(0, 300));

    site.engagementOff = true;
    const doc2 = { ...doc, articles: [{ ...doc.articles[1]!, external_id: "eng:3", slug: "engaged-three" }], engagement: { daily: [{ external_id: "eng:3", day: "2026-05-12", views: 3 }] } };
    const off = bodyOf(await handleImportContent(CTX, { data: doc2, dry_run: false }, memStore("g:key-engagement-off")));
    check(
      "an API without the engagement endpoint does not fail the import: the articles are done and the history is reported as not imported",
      off.includes("Import complete") && off.includes("Engagement history: NOT imported") && Boolean(byExternal("eng:3").id),
      off.slice(0, 800),
    );
    site.engagementOff = false;
  }

  // -- 14f2. Live articles with publish false: cost history and engagement still go ---------
  console.log("\n[ 14f2. Cost history reaches live articles left unchanged; the dry run says so and checks permissions ]");
  {
    currentKey = SECRET_KEY;
    const liveAt = "2025-03-01T10:00:00.000Z";
    for (const n of [1, 2, 3]) {
      site.articles.push({ id: randomUUID(), external_id: `live:${n}`, slug: `live-${n}`, title: `Live ${n}`, content: `Live body ${n}`, status: "published", published_at: liveAt });
    }
    const doc = {
      format: "writavo-import",
      version: 1,
      articles: [1, 2, 3].map((n) => ({
        external_id: `live:${n}`, status: "published", title: `Live ${n}`, slug: `live-${n}`, content: `Live body ${n}`, published_at: liveAt,
        cost_history: [{ cost_usd: 0.1 * n, stage: "generate", provider: "openai", occurred_on: "2025-02-27" }],
      })),
      engagement: { daily: [{ external_id: "live:1", day: "2025-04-01", views: 7 }] },
    };
    const store = memStore("g:key-live-costs");
    stub.reset();
    site.scopes = ["articles:read", "articles:write", "meta:read"];
    const dry = bodyOf(await handleImportContent(CTX, { data: doc, publish: false }, store));
    const liveId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "a dry run on live articles with publish false does not say there is nothing to import: it names the cost history and the engagement it will still write",
      !dry.includes("Nothing to import") && dry.includes("cost history to write on live articles: 3") && dry.includes("this import still has work to do") &&
        dry.includes("3 live articles") && dry.includes("the engagement history"),
      dry.slice(0, 1800),
    );
    check(
      "it names every permission the apply needs and which ones this connection is missing, and where to grant it",
      dry.includes("Permissions this import needs: articles:write (cost history), engagement:write (the engagement history)") &&
        dry.includes("MISSING on this connection: engagement:write") && dry.includes("Articles, Read and write") && dry.includes("reconnect Writavo"),
      dry.slice(dry.indexOf("Permissions"), dry.indexOf("Permissions") + 900),
    );
    check("nothing was written by the dry run", site.bulkCostCalls === 0 && byExternal("live:1").cost_history === undefined);

    site.scopes = null;
    stub.reset();
    const dry2 = bodyOf(await handleImportContent(CTX, { import_id: liveId, publish: false }, store));
    check("with every permission held the dry run says so", dry2.includes("This connection has all of them.") && !dry2.includes("MISSING"), dry2.slice(dry2.indexOf("Permissions"), dry2.indexOf("Permissions") + 400));

    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: liveId, dry_run: false, publish: false, background: false }, store));
    check(
      "an apply writes the cost history of the live articles in ONE bulk request, and leaves their content alone",
      applied.includes("Import complete") && site.bulkCostCalls === 1 &&
        (byExternal("live:2").cost_history as Row[])?.[0]?.cost_usd === 0.2 && byExternal("live:3").content === "Live body 3" && byExternal("live:1").status === "published" &&
        applied.includes("Cost history of live articles (their content was left as it is): written for 3 of 3") && applied.includes("Engagement history: delivered"),
      applied.slice(0, 1500),
    );
    const before = site.bulkCostCalls;
    const again = bodyOf(await handleImportContent(CTX, { import_id: liveId, dry_run: false, publish: false, background: false }, store));
    check("running it again sends no cost history twice", again.includes("Import complete") && site.bulkCostCalls === before, again.slice(0, 300));

    // an API that predates the bulk route: reported, and the import does not fail
    site.bulkCostOff = true;
    const other = { ...doc, articles: [{ ...doc.articles[0]!, external_id: "live:1", cost_history: [{ cost_usd: 9 }] }], engagement: undefined };
    const oldApi = bodyOf(await handleImportContent(CTX, { data: other, dry_run: false, publish: false }, memStore("g:key-live-costs-old")));
    check(
      "an API without the bulk route does not fail the import: the cost history is reported as not imported",
      oldApi.includes("Cost history of live articles: NOT imported, because this Site's API does not accept bulk cost history yet"),
      oldApi.slice(0, 900),
    );
    site.bulkCostOff = false;
  }

  // -- 14f3. import_content with no document is short; a section returns one part -------
  console.log("\n[ 14f3. import_content with no document is short, and section picks a part ]");
  {
    const guide = bodyOf(await handleImportContent(CTX, {}));
    check("with no arguments the reply is the guide and a sample, well under 20 KB, and lists the sections", guide.length < 20_000 && guide.includes("## Sample document") && guide.includes('section: "<name>"'), String(guide.length));
    const eng = bodyOf(await handleImportContent(CTX, { section: "engagement" }));
    check("section: engagement returns its guide text and its JSON Schema", eng.includes("Engagement (optional, top level)") && eng.includes("JSON Schema of the section") && eng.length < 20_000, String(eng.length));
    const cost = bodyOf(await handleImportContent(CTX, { section: "cost_history" }));
    check("section: cost_history returns the field's text and schema", cost.includes("cost_usd") && cost.includes("never billed") && cost.includes("JSON Schema of the field"), cost.slice(0, 300));
    const schema = bodyOf(await handleImportContent(CTX, { section: "schema" }));
    check("section: schema is the whole JSON Schema", schema.includes("Writavo Import Format v1") && schema.length > 50_000, String(schema.length));
  }

  // -- 14g. Redirects: articles' old_urls and the redirects section (0127) --------
  console.log("\n[ 14g. Old URLs travel with the import as redirects ]");
  {
    currentKey = SECRET_KEY;
    const doc = {
      format: "writavo-import",
      version: 1,
      articles: [
        {
          external_id: "wp:1", status: "draft", title: "Moved one", slug: "moved-one", content: "x",
          old_urls: ["https://example.com/2021/03/moved-one/", "https://example.com/?p=1"],
        },
      ],
      redirects: [
        { from: "https://example.com/category/news/", to: "/category/news" },
        { from: "https://EXAMPLE.com/2021/03/moved-one", to: "/elsewhere" },
        { from: "https://example.com/about/", to: "/about", to_external_id: "wp:1" },
        { from: "https://example.com/gone/", to_external_id: "wp:missing" },
      ],
    };
    const store = memStore("g:key-redirects");
    stub.reset();
    const dry = bodyOf(await handleImportContent(CTX, { data: doc }, store));
    const redId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "the dry run counts the old URLs, flags a duplicate and a row with two targets, and sends nothing",
      dry.includes("Redirects: 4 old URLs (3 from articles' old_urls, 1 from the redirects section)") &&
        dry.includes("is already redirected earlier in the document") && dry.includes("give exactly one of to or to_external_id") &&
        site.redirectCalls === 0,
      dry.slice(dry.indexOf("Redirects"), dry.indexOf("Redirects") + 700),
    );
    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: redId, dry_run: false, background: false }, store));
    check(
      "an apply writes the article, then sends the redirects once; a target that is not on the Site is reported",
      applied.includes("Import complete") && applied.includes("Redirects: delivered. Created 3") && site.redirectCalls === 1 &&
        (site.redirects.get("https://example.com/?p=1") as Row | undefined)?.to_external_id === "wp:1" &&
        applied.includes("https://example.com/gone/: no article with this external_id on this Site"),
      applied.slice(0, 1400),
    );
    const callsBefore = site.redirectCalls;
    const again = bodyOf(await handleImportContent(CTX, { import_id: redId, dry_run: false, background: false }, store));
    check("running it again sends nothing new (the redirects are already delivered)", again.includes("Import complete") && site.redirectCalls === callsBefore, again.slice(0, 300));
  }

  // -- 14j. Content types and entries (0136) ------------------------------------------
  console.log("\n[ 14j. Content types and entries travel, references and media resolved ]");
  {
    currentKey = SECRET_KEY;
    const ref = (type: string, external_id: string) => ({ $ref: { type, external_id } });
    const doc = {
      format: "writavo-import",
      version: 1,
      content_types: [
        { api_id: "product", kind: "collection", name: "Product", title_field: "name", fields: [
          { api_id: "name", name: "Name", type: "text" },
          { api_id: "related", name: "Related", type: "reference", to: ["product", "article"], list: true },
          { api_id: "photo", name: "Photo", type: "media" },
        ] },
        { api_id: "article", kind: "article_fields", name: "Article fields", fields: [{ api_id: "featured", name: "Featured", type: "reference", to: ["product"] }] },
      ],
      articles: [
        { external_id: "ct:a1", status: "draft", title: "With a product", slug: "with-a-product", content: "x", custom_fields: { featured: ref("product", "ct:p2") } },
      ],
      entries: [
        { external_id: "ct:p1", type: "product", slug: "one", status: "published", data: {
          name: "One", related: [ref("product", "ct:p2"), ref("article", "ct:a1")], photo: { $media: { url: "https://img.example.test/p1.png", alt: "P1" } } } },
        { external_id: "ct:p2", type: "product", data: { name: "Two", related: [ref("product", "ct:missing")] } },
        { external_id: "ct:bad", type: "nope", data: {} },
      ],
    };
    const store = memStore("g:key-content");
    stub.reset();
    const dry = bodyOf(await handleImportContent(CTX, { data: doc }, store));
    const ctId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "the dry run shows the Site's plan for the content types, the entries by type, the unknown type and the custom fields; it writes nothing",
      dry.includes("Content types: 2 in the file") && dry.includes("plan: create product, article") &&
        dry.includes("Entries: 2 (2 product)") && dry.includes('"nope" is not a content type') &&
        dry.includes("Articles' custom fields: 1 articles") && site.contentTypes.size === 0 && site.entryCreates === 0,
      dry.slice(dry.indexOf("Content types"), dry.indexOf("Content types") + 900),
    );
    const applied = bodyOf(await handleImportContent(CTX, { import_id: ctId, dry_run: false, background: false, confirm: true }, store));
    const p1 = site.entries.find((e) => e.external_id === "ct:p1");
    const p2 = site.entries.find((e) => e.external_id === "ct:p2");
    const a1 = site.articles.find((a) => a.external_id === "ct:a1");
    const p1data = (p1?.data ?? {}) as Row;
    check(
      "the apply creates the types, then the entries, then resolves references (entries and articles) and media into ids, and publishes",
      applied.includes("Import complete") && applied.includes("Content types: applied") && site.contentTypes.has("product") &&
        Array.isArray(p1data.related) && (p1data.related as unknown[])[0] === p2?.id && (p1data.related as unknown[])[1] === a1?.id &&
        typeof p1data.photo === "string" && /^[0-9a-f-]{36}$/.test(String(p1data.photo)) && p1?.status === "published" && p2?.status === "draft",
      `${applied.slice(0, 1200)}\n${JSON.stringify(site.entries)}`,
    );
    check(
      "a reference to something in neither the document nor the Site is left out and reported; the custom fields point at the entry",
      applied.includes("product ct:missing is not in this document or on the Site") &&
        Array.isArray((p2?.data as Row)?.related) && ((p2?.data as Row).related as unknown[]).length === 0 &&
        (a1?.custom_fields as Row | undefined)?.featured === p2?.id,
      applied.slice(0, 2000),
    );
    const creates = site.entryCreates;
    const again = bodyOf(await handleImportContent(CTX, { import_id: ctId, dry_run: false, background: false, confirm: true }, store));
    check("running it again creates nothing new", again.includes("Import complete") && site.entryCreates === creates, again.slice(0, 400));
  }

  // -- 14h. Scheduled posts and the SEO overrides (0128) ---------------------------
  console.log("\n[ 14h. Scheduled posts keep their time; SEO overrides travel with the article ]");
  {
    currentKey = SECRET_KEY;
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const doc = {
      format: "writavo-import",
      version: 1,
      articles: [
        {
          external_id: "sch:1", status: "scheduled", title: "Coming soon", slug: "coming-soon", content: "Soon.", scheduled_at: future,
          canonical_url: "https://partner.example.com/coming-soon", noindex: true, og_title: "Share me",
          og_description: "Shared text", og_image: { url: "https://img.example.test/og.png", alt: "Share alt" },
        },
        { external_id: "sch:2", status: "scheduled", title: "Too late", slug: "too-late", content: "Late.", scheduled_at: "2020-01-01T00:00:00Z" },
      ],
    };
    const store = memStore("g:key-scheduled");
    stub.reset();
    const dry = bodyOf(await handleImportContent(CTX, { data: doc }, store));
    const schId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "the dry run counts a scheduled article, and imports one whose time has passed as a draft, with a warning",
      dry.includes("2 scheduled") && dry.includes("to schedule for their future dates: 1") && dry.includes("has passed, so it is imported as a draft"),
      dry.slice(0, 1400),
    );
    const unconfirmed = bodyOf(await handleImportContent(CTX, { import_id: schId, dry_run: false, background: false }, store));
    check("scheduling needs the user's confirm, like publishing", unconfirmed.includes("needs the user to confirm") && unconfirmed.includes("schedules 1 article"), unconfirmed.slice(0, 600));
    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: schId, dry_run: false, background: false, confirm: true }, store));
    const soon = byExternal("sch:1");
    const late = byExternal("sch:2");
    check(
      "an apply schedules the future post for its time and leaves the past one a draft",
      applied.includes("Import complete") && soon.status === "scheduled" && soon.scheduled_publish_at === future && late.status === "draft" &&
        soon.original_published_at === undefined,
      `${String(soon.status)} ${String(soon.scheduled_publish_at)} / ${String(late.status)}`,
    );
    check(
      "the SEO overrides are written, and the share image is copied into the media library",
      soon.canonical_url === "https://partner.example.com/coming-soon" && soon.noindex === true && soon.og_title === "Share me" &&
        soon.og_description === "Shared text" && String(soon.og_image_url).startsWith("https://cdn.example.test/media/") && soon.og_image_alt === "Share alt",
      JSON.stringify({ og: soon.og_image_url, alt: soon.og_image_alt }),
    );
    const schedulesBefore = writes().filter((r) => r.path.endsWith("/schedule")).length;
    const again = bodyOf(await handleImportContent(CTX, { import_id: schId, dry_run: false, background: false, confirm: true }, store));
    check(
      "running it again schedules nothing twice",
      again.includes("Import complete") && writes().filter((r) => r.path.endsWith("/schedule")).length === schedulesBefore,
      again.slice(0, 300),
    );
  }

  // -- 14i. Native WordPress import (WXR) -------------------------------------------
  console.log("\n[ 14i. A WordPress export file is converted by Writavo itself ]");
  {
    const { convertWxr, readImportBody } = await import("../src/import/wordpress/index.js");
    const { checkDocument } = await import("../src/import/validate.js");
    const wxr = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/wordpress/sample.wxr.xml"), "utf8");
    const converted = convertWxr(wxr);
    const doc = "error" in converted ? null : (converted.document as { articles: Row[]; redirects: Row[]; authors: Row[]; categories: Row[] });
    const byId = (id: string) => doc?.articles.find((a) => a.external_id === id) ?? {};
    check(
      "a WXR file converts: posts, and the published page as a page; trash and menus left out",
      Boolean(doc) && doc!.articles.length === 7 && doc!.articles.find((a) => a.external_id === "wp:2")?.kind === "page",
      "error" in converted ? converted.error : "",
    );
    check(
      "statuses follow the owner's rules: publish, future -> scheduled, password / private / pending -> draft",
      byId("wp:101").status === "published" && byId("wp:103").status === "scheduled" && byId("wp:104").status === "draft" &&
        byId("wp:105").status === "draft" && byId("wp:106").status === "draft",
    );
    const body = String(byId("wp:101").content);
    check(
      "classic content gets its paragraphs back (wpautop) and its words unchanged, including 10:30 and note:important",
      body.startsWith("High water comes twice a day. Meet at 10:30, note:important.\n\nThe moon does most of the work.") && !body.includes("<!--"),
      body.slice(0, 200),
    );
    check(
      "a captioned image uses the original upload, with its caption under it; a gallery becomes its images",
      body.includes("![Boats at dawn](https://harbour.example.com/wp-content/uploads/2021/03/dawn.jpg)\n\n_Dawn over the harbour_") &&
        body.includes("![](https://harbour.example.com/wp-content/uploads/2021/03/chart.png)"),
    );
    check(
      "YouTube (a URL on its own line) and Vimeo ([embed]) become ::embed lines; a script is dropped; an unknown shortcode stays as text",
      body.includes('::embed{url="https://www.youtube.com/watch?v=dQw4w9WgXcQ"}') && body.includes('::embed{url="https://vimeo.com/76979871"}') &&
        !body.includes("alert(") && body.includes("contact-form-7"),
    );
    const block = String(byId("wp:102").content);
    check(
      "block content: the X embed block becomes an embed, a Spotify block a link, the image its full-size file (srcset), the table a table",
      block.includes('::embed{url="https://twitter.com/jack/status/20"}') && block.includes("https://open.spotify.com/track/abc") &&
        block.includes("chart.png") && !block.includes("chart-1024x683") && block.includes("| Tide"),
      block,
    );
    check(
      "every category comes across, the primary first, and the tree with it (a parent is named on its child)",
      byId("wp:101").category === "dinghies" && JSON.stringify(byId("wp:101").categories) === '["sailing"]' &&
        doc!.categories.some((c) => c.slug === "dinghies" && c.parent === "sailing") && doc!.categories.some((c) => c.slug === "sailing" && c.parent === undefined),
      JSON.stringify(doc!.categories),
    );
    check(
      "SEO: Yoast title template resolved, primary category chosen, Rank Math noindex and canonical kept",
      byId("wp:101").seo_title === "Reading the tides – a primer - Harbour Notes" && byId("wp:101").category === "dinghies" &&
        byId("wp:101").og_title === "Tides, simply" && byId("wp:102").noindex === true && byId("wp:102").canonical_url === "https://partner.example.com/original",
    );
    check(
      "old URLs: each post's permalink and ?p= link, and the (nested) category and tag archives as redirects",
      JSON.stringify(byId("wp:101").old_urls) === JSON.stringify(["https://harbour.example.com/2021/03/reading-the-tides/", "https://harbour.example.com/?p=101"]) &&
        doc!.redirects.some((r) => r.from === "https://harbour.example.com/category/sailing/dinghies/" && r.to === "/category/dinghies"),
    );
    check("a non-ASCII slug becomes an ASCII one, and the old permalink redirects to it", byId("wp:102").slug === "cafe-culture");
    const whole = JSON.stringify(converted);
    check("no author email, commenter email or post password is carried over", !whole.includes("private.example") && !whole.includes("hunter2"));
    const checked = checkDocument(doc);
    check(
      "the converted document passes the importer's own checks with no problems",
      checked.envelopeErrors.length === 0 && checked.items.every((i) => i.errors.length === 0),
      JSON.stringify(checked.items.filter((i) => i.errors.length)),
    );

    // Streamed in small, awkward chunks (as the Durable Object reads an upload): the same result.
    const bytes = new TextEncoder().encode(wxr);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 777) c.enqueue(bytes.slice(i, i + 777));
        c.close();
      },
    });
    const streamed = await readImportBody(stream, 10 * 1024 * 1024);
    check(
      "a streamed WXR body gives the same document as the whole file, and the report travels inside it",
      streamed.kind === "wxr" && JSON.stringify(streamed.conversion.document.articles) === JSON.stringify(doc!.articles) &&
        Array.isArray((streamed.conversion.document.conversion as { lines?: unknown })?.lines),
    );
    const jsonBody = await readImportBody(new Response('{"format":"writavo-import"}').body!, 1024);
    check("a JSON body is still read as JSON", jsonBody.kind === "json" && jsonBody.text === '{"format":"writavo-import"}');

    // Staged (the hosted Durable Object's way): posts to storage, converted a page per call, assembled.
    {
      const { stageWxr, convertStaged, assembleStaged, clearStaged, sniffBody } = await import("../src/import/wordpress/index.js");
      const kv = new Map<string, string>();
      const mem = { put: async (k: string, v: string) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null, remove: async (ks: string[]) => void ks.forEach((k) => kv.delete(k)) };
      // Many posts, so there are several pages: the tides post repeated under new ids.
      const one = wxr.slice(wxr.indexOf("<item>\n\t\t<title><![CDATA[Reading"), wxr.indexOf("</item>", wxr.indexOf("<item>\n\t\t<title><![CDATA[Reading")) + 7);
      const many = wxr.replace("</channel>", Array.from({ length: 120 }, (_, i) => one.replaceAll("<wp:post_id>101</wp:post_id>", `<wp:post_id>${5000 + i}</wp:post_id>`).replaceAll("reading-the-tides", `tides-${i}`)).join("\n") + "</channel>");
      const enc = new TextEncoder().encode(many);
      const body = await sniffBody(new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < enc.length; i += 4096) c.enqueue(enc.slice(i, i + 4096)); c.close(); } }));
      const staged = await stageWxr(body.head, body.rest, mem, 100 * 1024 * 1024, body.bytes);
      let calls = 0;
      let tick = 0;
      let state = staged.ok ? staged.state : null;
      // A clock that runs out after one page: one page per call, as an alarm with no time left would.
      while (state && state.converted < state.pages && calls < 50) {
        tick = 0;
        state = await convertStaged(mem, 1, { source: "wordpress-wxr", rawContent: true }, () => tick++);
        calls += 1;
      }
      const assembled = await assembleStaged(mem, { source: "wordpress-wxr", rawContent: true });
      const whole = convertWxr(many);
      check(
        "a staged export, converted one page per call, assembles to the same document as converting it in one go",
        body.wxr && staged.ok && calls >= 3 && !("error" in whole) &&
          JSON.stringify(assembled.document.articles) === JSON.stringify((whole as { document: { articles: unknown } }).document.articles),
        `pages ${state?.pages} calls ${calls}`,
      );
      await clearStaged(mem);
      check("clearing the stage leaves nothing behind", kv.size === 0, [...kv.keys()].join(","));
    }

    // A live site over its REST API: probed, pulled in resumable steps, converted, assembled.
    {
      const { probeSite, pullStep, convertStaged, assembleStaged, stagedOptions, readStageState, setSiteName, restBase } = await import("../src/import/wordpress/index.js");
      const kv = new Map<string, string>();
      const mem = { put: async (k: string, v: string) => void kv.set(k, v), get: async (k: string) => kv.get(k) ?? null, remove: async (ks: string[]) => void ks.forEach((k) => kv.delete(k)) };
      const seen: string[] = [];
      const auths: string[] = [];
      const posts = [
        {
          id: 201, type: "post", status: "publish", slug: "tide-clock", link: "https://wp.example.com/tide-clock/", guid: { rendered: "https://wp.example.com/?p=201" },
          title: { rendered: "The tide &amp; the clock" }, excerpt: { rendered: "<p>Short.</p>" },
          content: { rendered: '<p>Rendered <em>content</em>.</p>\n<figure class="wp-block-embed is-provider-youtube"><div class="wp-block-embed__wrapper"><iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed"></iframe></div></figure>', protected: false },
          date_gmt: "2023-02-03T04:05:06", modified_gmt: "2023-03-01T00:00:00", author: 7, categories: [3], tags: [9], featured_media: 55,
          yoast_head_json: { title: "Tide & clock - 100% useful", description: "Desc", canonical: "https://wp.example.com/tide-clock/", robots: { index: "index" }, og_title: "Tide & clock - 100% useful", og_image: [{ url: "https://wp.example.com/og.jpg" }] },
          _embedded: { author: [{ id: 7, slug: "ana", name: "Ana Mar" }], "wp:featuredmedia": [{ id: 55, source_url: "https://wp.example.com/hero.jpg", alt_text: "Hero" }] },
        },
        {
          id: 202, type: "post", status: "draft", slug: "", link: "https://wp.example.com/?p=202", title: { rendered: "Locked" },
          excerpt: { rendered: "" }, content: { rendered: "", raw: "Secret line one.\n\nSecret line two.", protected: true }, date_gmt: "2023-04-01T00:00:00", author: 7, categories: [], tags: [],
        },
      ];
      const reply = (body: unknown, pages = 1) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-wp-totalpages": String(pages), "x-wp-total": "2" } });
      const fetcher = async (url: string, init: { headers: Record<string, string> }) => {
        seen.push(new URL(url).pathname + new URL(url).search);
        if (init.headers.Authorization) auths.push(init.headers.Authorization);
        const u = new URL(url);
        if (u.pathname === "/wp-json/") return reply({ name: "WP Example" });
        if (u.pathname.endsWith("/users/me")) return reply({ id: 7 });
        if (u.pathname.endsWith("/categories")) return reply([{ id: 3, slug: "tides", name: "Tides", parent: 0, description: "" }]);
        if (u.pathname.endsWith("/tags")) return reply([{ id: 9, slug: "clocks", name: "Clocks" }]);
        if (u.pathname.endsWith("/posts")) return u.searchParams.get("page") === "1" ? reply([posts[0]], 2) : reply([posts[1]], 2);
        if (u.pathname.endsWith("/pages")) return reply([{ id: 2, type: "page", status: "publish", title: { rendered: "About" } }]);
        return new Response("not found", { status: 404 });
      };
      const site = { url: "wp.example.com/some/page", username: "admin", applicationPassword: "abcd efgh ijkl" };
      check("an address a person types resolves to its site's REST root; a private address is refused",
        (restBase("wp.example.com/blog/") as { base: string }).base === "https://wp.example.com/blog" &&
          "error" in restBase("http://wp.example.com") && "error" in restBase("https://192.168.1.10") && "error" in restBase("https://localhost"));
      const probe = await probeSite({ ...site, url: "https://wp.example.com" }, fetcher);
      check("the probe reads the site and checks the application password", probe.ok && seen.includes("/wp-json/wp/v2/users/me?context=edit"));
      let steps = 0;
      if (probe.ok) {
        await setSiteName(mem, probe.state.base, probe.name);
        let state = probe.state;
        for (;;) {
          const step = await pullStep({ ...site, url: "https://wp.example.com" }, state, mem, fetcher, 2);
          state = step.state;
          steps += 1;
          if (step.done || steps > 10) break;
        }
      }
      const staged = await readStageState(mem);
      await convertStaged(mem, Date.now() + 60_000, stagedOptions(staged!));
      const out = await assembleStaged(mem, stagedOptions(staged!));
      const arts = out.document.articles as Row[];
      const a = arts.find((x) => x.external_id === "wp:201") ?? {};
      const b = arts.find((x) => x.external_id === "wp:202") ?? {};
      check(
        "the pull is resumable (two requests a step here), reads drafts with the password, and never writes",
        steps >= 3 && seen.some((p) => p.includes("status=publish,future,draft,pending,private")) &&
          auths.every((h) => h === `Basic ${btoa("admin:abcdefghijkl")}`),
        `steps ${steps} ${seen.join(" ")}`,
      );
      check(
        "a REST post maps like a WXR one: rendered content, the embed, the featured image, author name, category, tag",
        String(a.content).startsWith("Rendered _content_.") && String(a.content).includes('::embed{url="https://www.youtube.com/embed/dQw4w9WgXcQ?feature=oembed"}') &&
          (a.featured_image as Row)?.url === "https://wp.example.com/hero.jpg" && a.category === "tides" && JSON.stringify(a.tags) === '["clocks"]' &&
          (out.document.authors as Row[]).some((x) => x.ref === "ana" && x.name === "Ana Mar"),
        JSON.stringify(a).slice(0, 600),
      );
      check(
        "Yoast's computed head is kept as text (a % is not a template), a self canonical is dropped, a same og title is not repeated",
        a.seo_title === "Tide & clock - 100% useful" && a.canonical_url === undefined && a.og_title === undefined && (a.og_image as Row)?.url === "https://wp.example.com/og.jpg",
        JSON.stringify({ t: a.seo_title, c: a.canonical_url, o: a.og_title }),
      );
      check(
        "a password-protected post comes in as a draft from its raw content, and the page comes across as a page",
        b.status === "draft" && String(b.content).includes("Secret line one.") && arts.some((x) => x.external_id === "wp:2" && x.kind === "page"),
        JSON.stringify(b).slice(0, 300),
      );
    }

    // Through import_content: the dry run shows the conversion report and the notes per article.
    currentKey = SECRET_KEY;
    const small = wxr.replace(/<item><title><!\[CDATA\[Menu[\s\S]*?<\/item>/, "");
    const store = memStore("g:key-wordpress");
    stub.reset();
    const dry = bodyOf(await handleImportContent(CTX, { data: small }, store));
    const wpId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "the dry run of a WordPress export shows the conversion report and each article's notes",
      dry.includes("Converted from a WordPress export file") && dry.includes("6 posts and 1 page") &&
        dry.includes("was password protected") && dry.includes("to schedule for their future dates: 1"),
      dry.slice(0, 1600),
    );
    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: wpId, dry_run: false, background: false, confirm: true }, store));
    const tides = byExternal("wp:101");
    check(
      "an apply writes the posts with their SEO fields, schedules the future one, and leaves the private one a draft",
      applied.includes("Import complete") && tides.status === "published" && tides.published_at === "2021-03-04T09:30:00Z" &&
        byExternal("wp:102").noindex === true && byExternal("wp:103").status === "scheduled" && byExternal("wp:105").status === "draft",
      applied.slice(0, 1200),
    );
    const again = bodyOf(await handleImportContent(CTX, { import_id: wpId, dry_run: false, background: false, confirm: true }, store));
    const sailing = site.categories.find((c) => c.slug === "sailing");
    const dinghies = site.categories.find((c) => c.slug === "dinghies");
    check(
      "the apply creates the tree (dinghies under sailing) and files the post under both categories",
      Boolean(sailing && dinghies) && dinghies!.parent_id === sailing!.id &&
        JSON.stringify(byExternal("wp:101").category_ids) === JSON.stringify([dinghies!.id, sailing!.id]),
      JSON.stringify({ dinghies, ids: byExternal("wp:101").category_ids }),
    );
    const patchesBefore = writes().filter((r) => r.path.startsWith("/categories/")).length;
    check("importing the same export again changes nothing twice", again.includes("Import complete") && site.articles.filter((a) => a.external_id === "wp:101").length === 1 && writes().filter((r) => r.path.startsWith("/categories/")).length === patchesBefore, again.slice(0, 300));
  }

  // -- 14c. The store does the document work (the hosted Durable Object) --------
  console.log("\n[ 14c. The store does the document work: the tool never reads a stored document ]");
  {
    const { runImport } = await import("../src/import/engine.js");
    const { jobSource, mergeImportDocuments } = await import("../src/import/jobs.js");
    const { readInlinePart } = await import("../src/tools/import-content.js");
    // What the Durable Object implements, done locally. Every read of the stored document by the
    // tool is recorded: on this path there must be none (a free-plan Worker cannot afford one).
    const toolReads: string[] = [];
    const base = memStore("g:key-docstore");
    const rawGet = base.getDocument.bind(base);
    const docStore: ImportJobStore = {
      ...base,
      async getDocument(id) {
        toolReads.push(id);
        return rawGet(id);
      },
      async addPart(id, part) {
        const read = readInlinePart(part);
        if ("error" in read) return { ok: false, error: read.error };
        const stored = await rawGet(id);
        const merged = stored ? mergeImportDocuments(JSON.parse(stored), read.document) : read.document;
        if (typeof merged === "string") return { ok: false, error: merged };
        const json = JSON.stringify(merged);
        await base.putDocument(id, json);
        const articles = (merged as { articles?: unknown[] }).articles;
        return { ok: true, bytes: json.length, articles: Array.isArray(articles) ? articles.length : null };
      },
      async addFromUrl() {
        return { ok: false, error: "no URL fetches in the smoke test" };
      },
      async runStored(id, run) {
        const doc = JSON.parse((await rawGet(id))!);
        const result = await runImport({ ...CTX, apiKey: () => run.apiKey }, jobSource(base, id, doc), {
          dryRun: run.dryRun,
          confirm: run.confirm,
          publish: run.publish,
          rehostImages: run.rehostImages,
          retryFailed: run.retryFailed,
          batchSize: run.batchSize ?? 100,
        });
        return { text: bodyOf(result), isError: result.isError === true, importStatus: result.importStatus };
      },
    };
    currentKey = SECRET_KEY;
    const doc = {
      format: "writavo-import",
      version: 1,
      articles: [
        { external_id: "store:1", status: "draft", title: "Store one", content: "One." },
        { external_id: "store:2", status: "draft", title: "Store two", content: "Two." },
      ],
    };
    stub.reset();
    const dry = bodyOf(await handleImportContent(CTX, { data: doc }, docStore));
    const storeId = /imp_[A-Za-z0-9_-]{22}/.exec(dry)?.[0] ?? "";
    check(
      "an inline dry run goes to the store: stored, dry-run there, named by its import_id",
      Boolean(storeId) && dry.includes("Nothing was written") && dry.includes("- create: 2") && writes().length === 0,
      dry.slice(0, 500),
    );
    const part = await handleImportContent(CTX, { data: { format: "writavo-import", version: 1, articles: [{ external_id: "store:3", status: "draft", title: "Store three", content: "Three." }] }, import_id: storeId }, docStore);
    check("a part is merged by the store, then dry-run there", bodyOf(part).includes("- create: 3"), bodyOf(part).slice(0, 300));
    stub.reset();
    const applied = bodyOf(await handleImportContent(CTX, { import_id: storeId, dry_run: false, background: false }, docStore));
    check(
      "a foreground apply by import_id runs in the store and imports everything",
      applied.includes("Import complete") && ["store:1", "store:2", "store:3"].every((e) => byExternal(e).id),
      applied.slice(0, 400),
    );
    check("on this path the tool itself never read the stored document", toolReads.length === 0, toolReads.join(", "));
    const missing = await handleImportContent(CTX, { import_id: "imp_AAAAAAAAAAAAAAAAAAAAAA" }, docStore);
    check("an unknown import_id on this path is refused as missing", missing.isError === true && bodyOf(missing).includes("There is no import"));
  }

  // -- 15. MCP-2: the core, approvals, headers ------------------------------
  console.log("\n[ 15. The core as the Worker mounts it, approvals and headers ]");

  // The version is one constant, and every file that states it agrees.
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
  const pkgJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
    private?: boolean;
    publishConfig?: unknown;
    scripts?: Record<string, string>;
    bin?: unknown;
    main?: unknown;
    files?: unknown;
    exports?: Record<string, unknown>;
  };
  const serverJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "server.json"), "utf8")) as { version: string; packages?: unknown[]; remotes?: { type: string; url: string }[] };
  const mcpJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "mcp.json"), "utf8")) as { mcpServers: Record<string, { type?: string; command?: string }> };
  const pluginJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
  check(
    `the version is ${VERSION} in the code, package.json, server.json and the Claude plugin`,
    VERSION === pkg.version && serverJson.version === pkg.version && pluginJson.version === pkg.version,
    `${VERSION} / ${pkg.version} / ${serverJson.version} / ${pluginJson.version}`,
  );
  check(
    "server.json lists the hosted server as a streamable-http remote",
    serverJson.remotes?.some((r) => r.type === "streamable-http" && r.url === "https://mcp.writavo.com/mcp") === true,
  );
  // Owner decision 2026-09-27: the npm package is dropped and the hosted server is the only way in.
  check(
    "the package is private and never published (no publishConfig, no prepublishOnly)",
    pkgJson.private === true && pkgJson.publishConfig === undefined && pkgJson.scripts?.prepublishOnly === undefined,
  );
  check(
    "package.json has no bin, no main entry and no files list, and exports only ./core",
    pkgJson.bin === undefined && pkgJson.main === undefined && pkgJson.files === undefined &&
      JSON.stringify(Object.keys(pkgJson.exports ?? {}).sort()) === JSON.stringify(["./core", "./package.json"]) &&
      pkgJson.scripts?.start === undefined,
    JSON.stringify({ bin: pkgJson.bin, main: pkgJson.main, exports: Object.keys(pkgJson.exports ?? {}) }),
  );
  check("server.json lists no npm/stdio package, only the hosted remote", serverJson.packages === undefined || serverJson.packages.length === 0);
  check(
    "mcp.json offers no local stdio server",
    Object.values(mcpJson.mcpServers).every((server) => server.type !== "stdio" && server.command === undefined),
  );

  // The core as the Worker mounts it: a key from the grant, no filesystem, no login tools.
  const STDIO_ONLY_TOOLS = ["login", "login_status", "logout"];
  let remoteKey: string | null = SECRET_KEY;
  const remote = createWritavoMcpServer({
    apiKey: () => remoteKey,
    apiBase: baseUrl,
    userAgent: "writavo-mcp-smoke-worker/1.0",
    host: "remote",
    notSignedInHint: "SMOKE-HINT: reconnect the connector.",
    // What the Worker sends, plus two it must never be able to set.
    extraHeaders: () => ({ "X-Writavo-Mcp-Worker": "door-code", Authorization: "Bearer wv_sk_hijack000000000", "writavo-mcp-tool": "hijack" }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "writavo-mcp-smoke", version: "1.0.0" });
  await Promise.all([remote.connect(serverSide), client.connect(clientSide)]);
  const remoteTools = (await client.listTools()).tools;
  check(
    `the core lists ${remoteTools.length} tools: every generated one plus ${CORE_LOCAL_TOOL_NAMES.join(", ")}`,
    remoteTools.length === OPERATIONS.length + CORE_LOCAL_TOOL_NAMES.length &&
      CORE_LOCAL_TOOL_NAMES.every((n) => remoteTools.some((t) => t.name === n)),
    `${remoteTools.length} vs ${OPERATIONS.length} + ${CORE_LOCAL_TOOL_NAMES.length}`,
  );
  check(
    "the hosted server has no login, login_status or logout",
    STDIO_ONLY_TOOLS.every((n) => !remoteTools.some((t) => t.name === n) && !(CORE_LOCAL_TOOL_NAMES as readonly string[]).includes(n)),
  );
  check(
    "every tool carries all four annotations, and only the URL-fetching tools claim an open world",
    remoteTools.every(
      (t) =>
        typeof t.annotations?.readOnlyHint === "boolean" &&
        typeof t.annotations?.destructiveHint === "boolean" &&
        typeof t.annotations?.idempotentHint === "boolean" &&
        t.annotations?.openWorldHint === OPEN_WORLD_TOOLS.has(t.name),
    ),
    remoteTools.filter((t) => t.annotations?.openWorldHint !== OPEN_WORLD_TOOLS.has(t.name)).map((t) => t.name).join(", "),
  );
  const annotationOf = (name: string) => remoteTools.find((t) => t.name === name)?.annotations ?? {};
  check(
    "reads are read-only, deletes and unpublish are destructive, and a create is not idempotent",
    annotationOf("list_articles").readOnlyHint === true &&
      annotationOf("delete_article").destructiveHint === true &&
      annotationOf("unpublish_article").destructiveHint === true &&
      annotationOf("publish_article").destructiveHint === false &&
      annotationOf("create_article").idempotentHint === false &&
      annotationOf("update_article").idempotentHint === true,
    JSON.stringify({ del: annotationOf("delete_article"), unp: annotationOf("unpublish_article") }),
  );
  const schemaProps = (name: string) => Object.keys((remoteTools.find((t) => t.name === name)?.inputSchema as { properties?: object })?.properties ?? {});
  check(
    "the hosted import_content takes data and no path; upload_media takes url or base64 and no path",
    schemaProps("import_content").includes("data") && !schemaProps("import_content").includes("path") &&
      ["url", "base64", "filename"].every((p) => schemaProps("upload_media").includes(p)) && !schemaProps("upload_media").includes("path"),
    `${schemaProps("import_content").join(",")} | ${schemaProps("upload_media").join(",")}`,
  );

  // The same tool calls, through the core, against the stub.
  stub.reset();
  stub.respond = siteRespond;
  const remoteSite = await client.callTool({ name: "get_site_info", arguments: {} });
  check(
    "the host's extra headers are sent, and cannot replace Authorization or Writavo-Mcp-Tool",
    stub.requests[0]?.worker === "door-code",
    JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
  );
  check(
    "a core tool call sends the connection's key, the host's user agent and the tool name",
    stub.requests[0]?.authorization === `Bearer ${SECRET_KEY}` &&
      stub.requests[0]?.userAgent === "writavo-mcp-smoke-worker/1.0" &&
      stub.requests[0]?.mcpTool === "get_site_info" &&
      !remoteSite.isError,
    JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
  );
  remoteKey = null;
  stub.reset();
  const remoteNoKey = await client.callTool({ name: "list_articles", arguments: {} });
  const remoteNoKeyText = JSON.stringify(remoteNoKey.content);
  check(
    "with no key the core says how to reconnect, with the host's hint, and sends nothing",
    remoteNoKey.isError === true && remoteNoKeyText.includes("Reconnect Writavo") && remoteNoKeyText.includes("SMOKE-HINT") &&
      !remoteNoKeyText.includes("WRITAVO_API_KEY") && stub.requests.length === 0,
    remoteNoKeyText.slice(0, 300),
  );
  remoteKey = SECRET_KEY;

  // Inline import: limits first, then a real dry run and apply through the core.
  const tooMany = await client.callTool({
    name: "import_content",
    arguments: {
      data: { format: "writavo-import", version: 1, articles: Array.from({ length: 51 }, (_, i) => ({ external_id: `x:${i}`, status: "draft" })) },
    },
  });
  check(
    "an inline import over 50 articles is refused before anything is read",
    tooMany.isError === true && JSON.stringify(tooMany.content).includes("at most 50"),
    JSON.stringify(tooMany.content).slice(0, 200),
  );
  const inlineDoc = {
    format: "writavo-import",
    version: 1,
    articles: [
      { external_id: "inline:1", status: "draft", title: "Inline one", content: "Body one." },
      { external_id: "inline:2", status: "draft", title: "Inline two", content: "Body two." },
    ],
  };
  stub.reset();
  const inlineDry = JSON.stringify((await client.callTool({ name: "import_content", arguments: { data: inlineDoc } })).content);
  check(
    "an inline dry run reports what it would do and writes nothing",
    inlineDry.includes("Dry run of the inline document") && inlineDry.includes("- create: 2") && writes().length === 0,
    inlineDry.slice(0, 300),
  );
  stub.reset();
  const inlineApply = JSON.stringify((await client.callTool({ name: "import_content", arguments: { data: JSON.stringify(inlineDoc), dry_run: false } })).content);
  check(
    "an inline apply, sent as JSON text, creates both drafts and needs no progress file",
    inlineApply.includes("Import complete") && posts("/articles").length === 2 && site.articles.some((a) => a.external_id === "inline:2") &&
      stub.requests.every((r) => r.mcpTool === "import_content"),
    inlineApply.slice(0, 400),
  );
  stub.reset();
  const inlineAgain = JSON.stringify((await client.callTool({ name: "import_content", arguments: { data: inlineDoc, dry_run: false } })).content);
  check(
    "sending the same inline document again updates by external_id and duplicates nothing",
    inlineAgain.includes("Import complete") && posts("/articles").length === 0 && site.articles.filter((a) => String(a.external_id).startsWith("inline:")).length === 2,
    inlineAgain.slice(0, 300),
  );

  // base64 upload through the whole handshake.
  presignedPuts.length = 0;
  stub.reset();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]).toString("base64");
  const uploaded = await client.callTool({ name: "upload_media", arguments: { base64: png, filename: "pixel.png", alt_text: "A pixel" } });
  check(
    "upload_media with base64 reserves, transfers and registers",
    uploaded.isError !== true && posts("/media/upload-url").length === 1 && presignedPuts.length === 1 && posts("/media").length === 1,
    JSON.stringify(uploaded.content).slice(0, 200),
  );
  const noName = await client.callTool({ name: "upload_media", arguments: { base64: png } });
  check("base64 without a filename is refused", noName.isError === true && JSON.stringify(noName.content).includes("filename"));
  await client.close();

  // Approvals. A gated operation takes approval_id and sends it back as Writavo-Approval.
  const gated = OPERATIONS.filter((o) => o.approval);
  if (gated.length > 0) {
    check(
      `the ${gated.length} gated tools (x-writavo-approval) take approval_id`,
      gated.every((o) => "approval_id" in inputShapeFor(o)),
      gated.filter((o) => !("approval_id" in inputShapeFor(o))).map((o) => o.tool).join(", "),
    );
  } else {
    console.log("        (the vendored openapi.yaml has no x-writavo-approval yet; checked on a synthetic operation below)");
  }
  check(
    "an ungated tool does not take approval_id",
    OPERATIONS.filter((o) => !o.approval).every((o) => !("approval_id" in inputShapeFor(o))),
  );
  const gatedDelete = { ...operation("delete_article"), approval: "article.delete" };
  check("a synthetic gated operation grows approval_id", "approval_id" in inputShapeFor(gatedDelete));

  const APPROVAL_ID = "11111111-2222-4333-8444-555555555555";
  stub.reset();
  stub.respond = () => ({
    status: 428,
    body: {
      ok: false,
      error: {
        code: "APPROVAL_REQUIRED",
        message: "A person has to approve this.",
        approval: { id: APPROVAL_ID, url: `https://app.writavo.com/approvals/${APPROVAL_ID}`, expires_at: "2030-01-02T00:00:00Z", status: "pending" },
      },
    },
  });
  const parked = await callOperation(CTX, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true });
  const parkedBody = bodyOf(parked);
  check(
    "a 428 becomes an ordinary result: open the link, approve, call again with approval_id",
    parked.isError !== true &&
      parkedBody.startsWith("Nothing has been done yet.") &&
      parkedBody.includes(`https://app.writavo.com/approvals/${APPROVAL_ID}`) &&
      parkedBody.includes(`approval_id: "${APPROVAL_ID}"`) &&
      parkedBody.includes("exactly the same arguments") &&
      !/\b428\b/.test(parkedBody),
    parkedBody.slice(0, 400),
  );
  // Links the API might carry that must never reach a person: another host, a tenant's own
  // <slug>.writavo.com hosted blog, an http downgrade, and the right page for the wrong id.
  const badLinks = [
    "https://evil.example.com/approve",
    `https://acme.writavo.com/approvals/${APPROVAL_ID}`,
    `http://app.writavo.com/approvals/${APPROVAL_ID}`,
    `https://app.writavo.com.evil.example/approvals/${APPROVAL_ID}`,
    "https://app.writavo.com/approvals/99999999-9999-4999-8999-999999999999",
  ];
  for (const bad of badLinks) {
    stub.respond = () => ({
      status: 428,
      body: { ok: false, error: { code: "APPROVAL_REQUIRED", message: "x", approval: { id: APPROVAL_ID, url: bad, expires_at: null, status: "pending" } } },
    });
    const shown = bodyOf(await callOperation(CTX, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true }));
    check(
      `an approval link other than app.writavo.com/approvals/<id> is replaced: ${bad}`,
      !shown.includes(bad) && shown.includes(`https://app.writavo.com/approvals/${APPROVAL_ID}`),
      shown.slice(0, 300),
    );
  }
  stub.reset();
  stub.respond = () => ({ status: 200, body: { ok: true, data: { id: "x" } } });
  await callOperation(CTX, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true, approval_id: APPROVAL_ID });
  check(
    "the retry sends the approval as Writavo-Approval, with the tool name",
    stub.requests[0]?.approval === APPROVAL_ID && stub.requests[0]?.mcpTool === "delete_article",
    JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
  );
  stub.reset();
  await callOperation(CTX, { ...operation("delete_article"), approval: null }, { id: "00000000-0000-4000-8000-000000000000", confirm: true, approval_id: APPROVAL_ID });
  check("an ungated tool never sends Writavo-Approval", stub.requests[0]?.approval === null);

  const refusal = async (status: number, code: string) => {
    stub.respond = () => ({ status, body: { ok: false, error: { code, message: `The API said ${code}.` } } });
    return callOperation(CTX, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true, approval_id: APPROVAL_ID });
  };
  const deniedApproval = await refusal(403, "APPROVAL_DENIED");
  check(
    "APPROVAL_DENIED says a person denied it and not to retry",
    deniedApproval.isError === true && /denied|said no/.test(bodyOf(deniedApproval)) && /not retry/i.test(bodyOf(deniedApproval)),
    bodyOf(deniedApproval).slice(0, 300),
  );
  const invalidApproval = await refusal(409, "APPROVAL_INVALID");
  check(
    "APPROVAL_INVALID says to call again without approval_id",
    invalidApproval.isError === true && /WITHOUT approval_id/i.test(bodyOf(invalidApproval)),
    bodyOf(invalidApproval).slice(0, 300),
  );
  const agentsOff = await refusal(403, "AGENT_ACCESS_DISABLED");
  check(
    "AGENT_ACCESS_DISABLED names Settings > AI agents",
    agentsOff.isError === true && bodyOf(agentsOff).includes("app.writavo.com/settings/agents"),
    bodyOf(agentsOff).slice(0, 300),
  );
  check(
    "no approval reply carries a raw status code",
    ![deniedApproval, invalidApproval, agentsOff].some((r) => /\b(403|409)\b/.test(bodyOf(r))),
  );
  stub.respond = siteRespond;

  // Every request an operation makes is labelled with its tool.
  stub.reset();
  await callOperation(CTX, operation("list_articles"), {});
  check(
    "every API request names its tool in Writavo-Mcp-Tool and sends the host's user agent",
    stub.requests[0]?.mcpTool === "list_articles" && stub.requests[0]?.userAgent === USER_AGENT,
    JSON.stringify(stub.requests[0] ?? {}).slice(0, 200),
  );

  // The generated surface never exposes the host-owned key routes.
  check(
    "no generated tool reaches /auth/*, and every /auth/key/* route is a documented refusal",
    OPERATIONS.every((o) => !o.path.startsWith("/auth/")) &&
      REFUSALS.filter((r) => r.path.startsWith("/auth/key/")).every((r) => r.reason.includes("never by an assistant")),
  );

  // The generator itself, on a synthetic specification: the extension becomes approval_id, and a
  // /auth/key/* route under a tool tag is withheld anyway.
  const genDir = mkdtempSync(join(PACKAGE_ROOT, ".smoke-gen-"));
  try {
    const { parse, stringify } = await import("yaml");
    const spec = parse(readFileSync(join(PACKAGE_ROOT, "openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    // Start from no gates at all, so the count below is exactly what this test adds.
    // (Its companions go too: an x-writavo-approval-always with no gate is refused by the generator.)
    for (const item of Object.values(spec.paths)) {
      for (const op of Object.values(item)) {
        if (!op || typeof op !== "object") continue;
        for (const key of Object.keys(op)) if (key.startsWith("x-writavo-approval")) delete op[key];
      }
    }
    spec.paths["/articles/{id}"]!.delete!["x-writavo-approval"] = "article.delete";
    spec.paths["/articles/{id}/unpublish"]!.post!["x-writavo-approval"] = "article.unpublish";
    spec.paths["/auth/key/extend"] = {
      post: { operationId: "extendApiKeySmoke", tags: ["Device sign-in"], summary: "Extend the key in use", "x-scope": "none", responses: { "200": { description: "ok" } } },
    };
    mkdirSync(join(genDir, "scripts"), { recursive: true });
    for (const f of ["gen-mcp-tools.mjs", "mcp-surface.mjs", "error-guidance.mjs"]) {
      writeFileSync(join(genDir, "scripts", f), readFileSync(join(PACKAGE_ROOT, "scripts", f)));
    }
    writeFileSync(join(genDir, "openapi.yaml"), stringify(spec));
    const gen = spawnSync(process.execPath, [join(genDir, "scripts", "gen-mcp-tools.mjs")], { cwd: genDir, encoding: "utf8" });
    const generated = existsSync(join(genDir, "src", "generated", "operations.ts")) ? readFileSync(join(genDir, "src", "generated", "operations.ts"), "utf8") : "";
    const rows = JSON.parse(generated.slice(generated.indexOf("export const OPERATIONS: McpOperation[] = ") + 42, generated.indexOf(";\n\nexport const REFUSALS"))) as { tool: string; approval: string | null; description: string }[];
    const synthetic = rows.find((r) => r.tool === "delete_article");
    check(
      "the generator reads x-writavo-approval into the operation, and says so in its description",
      gen.status === 0 && synthetic?.approval === "article.delete" && /approval_id/.test(synthetic?.description ?? "") &&
        rows.find((r) => r.tool === "unpublish_article")?.approval === "article.unpublish" &&
        rows.filter((r) => r.approval).length === 2,
      `${gen.status} ${gen.stderr.slice(0, 300)}`,
    );
    check(
      "a /auth/key/* route is withheld from the tools even under a tool tag",
      !rows.some((r) => r.tool === "extend_api_key_smoke") && generated.includes('"operationId": "extendApiKeySmoke"'),
    );
  } finally {
    rmSync(genDir, { recursive: true, force: true });
  }

  // The package must run where there is no filesystem and no environment: every module under src/,
  // not only what the core entry reaches, and every one of them reachable from that entry (so no
  // host code is left behind unused).
  const srcRoot = join(PACKAGE_ROOT, "src");
  const allModules = (readdirSync(srcRoot, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .map((f) => join(srcRoot, f));
  const coreGraph = new Set<string>();
  const forbidden: string[] = [];
  const scan = (file: string): string[] => {
    // Comments may mention process.env; code may not.
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const name = relative(PACKAGE_ROOT, file);
    const local: string[] = [];
    const specs = [
      ...[...source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]!),
      // import("...") too: a dynamic import (or a type-only one) reaches a module just the same.
      ...[...source.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]!),
    ];
    for (const spec of specs) {
      if (/^(node:)?(fs|fs\/promises|os|path|child_process|net|http|https|worker_threads|readline)$/.test(spec)) forbidden.push(`${name} imports ${spec}`);
      if (/@modelcontextprotocol\/sdk\/server\/stdio/.test(spec)) forbidden.push(`${name} imports the stdio transport`);
      if (spec.startsWith(".")) local.push(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
    if (/process\.(env|argv|cwd|exit|platform|stdout|stderr|stdin)/.test(source)) forbidden.push(`${name} reads process`);
    return local;
  };
  for (const file of allModules) scan(file);
  const walk = (file: string): void => {
    if (coreGraph.has(file)) return;
    coreGraph.add(file);
    for (const next of scan(file)) walk(next);
  };
  walk(join(srcRoot, "core", "index.ts"));
  check(
    `all ${allModules.length} modules in src/ touch no filesystem, no environment and no stdio transport`,
    forbidden.length === 0 && allModules.length > 15,
    [...new Set(forbidden)].join("; "),
  );
  const orphans = allModules.filter((f) => !coreGraph.has(f)).map((f) => relative(PACKAGE_ROOT, f));
  check(`every module in src/ is reachable from the core entry (${coreGraph.size} of ${allModules.length})`, orphans.length === 0, orphans.join(", "));
  check(
    "the stdio host is gone: no entry point, no saved sign-in, no device login, no local file support",
    ["index.ts", "server.ts", "config.ts", "credentials.ts", "stdio", "auth", join("tools", "login.ts")].every((f) => !existsSync(join(srcRoot, f))),
  );
  globalThis.fetch = realFetch;

  // -- 16. MCP-3: search and run ----------------------------------------------
  console.log("\n[ 16. MCP-3: the actions catalog, search_writavo_actions and run_writavo_action ]");
  const {
    SEARCH_WRITAVO_ACTIONS,
    RUN_WRITAVO_ACTION,
    READ_WRITAVO_ACTION,
    compactInputSchema,
    handleReadAction,
    handleRunAction,
    handleSearchActions,
    searchActions,
    searchCatalog,
  } = await import("../src/tools/actions.js");
  const { ACTIONS: REAL_ACTIONS, ACTION_AREAS: REAL_AREAS } = await import("../src/generated/operations.js");
  const surfaceModule = (await import(join(PACKAGE_ROOT, "scripts", "mcp-surface.mjs"))) as {
    LOCAL_TOOLS: { name: string }[];
    NEVER_ACTIONS: { what: string; why: string; next_step: string }[];
  };

  check(
    "search_writavo_actions, read_writavo_action and run_writavo_action are core tools, and listed for the docs page",
    ["search_writavo_actions", "read_writavo_action", "run_writavo_action"].every(
      (n) => CORE_LOCAL_TOOL_NAMES.includes(n as never) && surfaceModule.LOCAL_TOOLS.some((t) => t.name === n),
    ),
  );
  check(
    "no catalog action is also an individual tool",
    REAL_ACTIONS.every((a) => !OPERATIONS.some((o) => o.operationId === a.operationId)) && REAL_ACTIONS.every((a) => a.surface === "action"),
  );
  check(
    `the real catalog (${REAL_ACTIONS.length} actions) is coherent: every row has an area in ACTION_AREAS and a schema that builds`,
    REAL_ACTIONS.every((a) => (REAL_AREAS as readonly string[]).includes(a.area) && compactInputSchema(a).type === "object"),
  );
  check(
    "every gated action has a consequence and an approval mode; every paid action asks first",
    REAL_ACTIONS.filter((a) => a.approval).every((a) => a.consequence && a.approvalMode) &&
      REAL_ACTIONS.filter((a) => a.spendsCredits || a.spendsMoney).every((a) => a.confirm),
  );
  check(
    "the NEVER list names a next step for each item",
    surfaceModule.NEVER_ACTIONS.length >= 10 && surfaceModule.NEVER_ACTIONS.every((n) => n.next_step.length > 20),
  );
  const toolsRef = handleGetApiDocs({ section: "tools" });
  check(
    "get_api_docs section tools explains actions and the never list with links",
    bodyOf(toolsRef).includes("search_writavo_actions") && bodyOf(toolsRef).includes("Never through an AI agent") &&
      bodyOf(toolsRef).includes("https://app.writavo.com/settings/agents"),
  );

  // The generator, on a fixture that adds MCP-3 routes to the vendored specification: a Team route
  // gated always, a paid custom domain, a Pipeline route that is NOT in the MCP-2 tool list (so it
  // must become an action with no marker), a route needing two scopes, and an explicit override.
  const fixtureDir = mkdtempSync(join(PACKAGE_ROOT, ".smoke-actions-"));
  type ActionRow = { operationId: string; tool: string; surface: string; area: string; approval: string | null; approvalMode: string | null; confirm: boolean; confirmReason: string | null; description: string; consequence: string | null; spendsMoney: boolean; alsoScopes: string[]; params: { name: string }[] };
  let FIXTURE_ACTIONS: typeof REAL_ACTIONS = [];
  try {
    const { parse, stringify } = await import("yaml");
    const base = () => parse(readFileSync(join(PACKAGE_ROOT, "openapi.yaml"), "utf8")) as {
      tags: { name: string; "x-mcp-surface"?: string }[];
      paths: Record<string, Record<string, unknown>>;
    };
    const idem = { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } };
    const json = (properties: Record<string, unknown>, required: string[] = []) => ({
      required: true,
      content: { "application/json": { schema: { type: "object", additionalProperties: false, required, properties } } },
    });
    const op = (operationId: string, tag: string, summary: string, description: string, extra: Record<string, unknown> = {}) => ({
      operationId,
      tags: [tag],
      summary,
      description,
      "x-publishable": false,
      responses: { "200": { description: "ok" } },
      ...extra,
    });
    const withFixture = (mutate?: (spec: ReturnType<typeof base>) => void) => {
      const spec = base();
      for (const [name, surface] of [["Team", "action"], ["Billing", "action"], ["Site settings", undefined], ["Delivery", "action"], ["SEO", "action"]] as const) {
        const tag = spec.tags.find((t) => t.name === name);
        if (!tag) spec.tags.push({ name, ...(surface ? { "x-mcp-surface": surface } : {}) });
      }
      spec.paths["/site/settings"] = {
        get: op("getSiteSettings", "Site settings", "Read the Site settings", "The Site's name, primary domain, locale and niche.", { "x-scope": "site:read" }),
        patch: op("updateSiteSettings", "Site settings", "Update the Site settings", "Rename the Site, or change its primary domain, locale or niche.", {
          "x-scope": "site:write",
          requestBody: json({
            name: { type: "string", description: "The Site's name." },
            primary_domain: { type: ["string", "null"], description: "The customer's domain." },
            locale_language: { type: "string", description: "Two letters." },
          }),
        }),
      };
      spec.paths["/team/invites"] = {
        post: op("inviteTeamMember", "Team", "Invite a team member", "Invite someone to the organisation by email with a role. Returns an accept link to hand over.", {
          "x-scope": "team:write",
          "x-writavo-approval": "member.invite",
          "x-writavo-approval-always": true,
          "x-writavo-approval-kind": "team",
          "x-agent-consequence": "Gives this person access to every Site in the organisation once they accept.",
          parameters: [idem],
          requestBody: json({ email: { type: "string", format: "email" }, role: { type: "string", enum: ["admin", "editor", "viewer"] } }, ["email", "role"]),
        }),
      };
      spec.paths["/team/members/{user_id}"] = {
        delete: op("removeTeamMember", "Team", "Remove a team member", "Remove a member from the organisation.", {
          "x-scope": "team:write",
          "x-writavo-approval": "member.remove",
          "x-writavo-approval-always": true,
          "x-agent-consequence": "The member loses access to every Site in the organisation at once.",
          parameters: [{ name: "user_id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        }),
      };
      spec.paths["/delivery/custom-domain"] = {
        post: op("connectCustomDomain", "Delivery", "Connect a custom domain", "Serve the blog on a hostname the customer owns, with SSL.", {
          "x-scope": "delivery:write",
          "x-spends-money": true,
          "x-writavo-approval": "domain.connect",
          "x-writavo-approval-always": true,
          "x-agent-consequence": "Costs 5 US dollars a month from the day the domain verifies.",
          parameters: [idem],
          requestBody: json({ hostname: { type: "string", description: "For example blog.example.com." } }, ["hostname"]),
        }),
      };
      spec.paths["/billing"] = {
        get: op("getBillingSummary", "Billing", "Read the billing summary", "The plan, the credit balance, allowances and the overage estimate.", { "x-scope": "billing:read" }),
      };
      spec.paths["/pipeline/config"] = {
        patch: op("updatePipelineConfig", "Pipeline", "Update the pipeline configuration", "Turn the AI pipeline on or off and change its cadence and batch size.", {
          "x-scope": "pipeline:config",
          "x-spends-credits": true,
          "x-writavo-approval": "pipeline.configure",
          "x-writavo-approval-always": true,
          "x-writavo-approval-when": "Asked only when the change makes the pipeline do more.",
          "x-agent-consequence": "Turning the pipeline on or up spends credits on every run it starts.",
          requestBody: json({ enabled: { type: "boolean" }, batch_size: { type: "integer" } }),
        }),
      };
      spec.paths["/seo/content-gaps/{id}/plan"] = {
        post: op("planContentGap", "SEO", "Plan a content gap", "Turn a content gap into a content plan topic.", {
          "x-scope": "seo:write",
          "x-also-scopes": ["plan:write"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }, idem],
        }),
      };
      // The contract marks pipeline runs always-gated; say so on the vendored route too, so the
      // fixture reads the same whichever specification it starts from.
      const runs = (spec.paths["/pipeline/runs"] as Record<string, Record<string, unknown>> | undefined)?.post;
      if (runs && runs["x-writavo-approval"]) runs["x-writavo-approval-always"] = true;
      mutate?.(spec);
      return spec;
    };
    mkdirSync(join(fixtureDir, "scripts"), { recursive: true });
    for (const f of ["gen-mcp-tools.mjs", "mcp-surface.mjs", "error-guidance.mjs"]) {
      writeFileSync(join(fixtureDir, "scripts", f), readFileSync(join(PACKAGE_ROOT, "scripts", f)));
    }
    const generate = (spec: unknown) => {
      writeFileSync(join(fixtureDir, "openapi.yaml"), stringify(spec));
      return spawnSync(process.execPath, [join(fixtureDir, "scripts", "gen-mcp-tools.mjs")], { cwd: fixtureDir, encoding: "utf8" });
    };

    const gen = generate(withFixture());
    const generatedFile = join(fixtureDir, "src", "generated", "operations.ts");
    check("the generator compiles the fixture", gen.status === 0 && existsSync(generatedFile), `${gen.status} ${gen.stderr.slice(0, 400)}`);
    const fixtureModule = (await import(generatedFile)) as { ACTIONS: typeof REAL_ACTIONS; ACTION_AREAS: readonly string[]; OPERATIONS: typeof OPERATIONS };
    FIXTURE_ACTIONS = fixtureModule.ACTIONS;
    const row = (id: string) => FIXTURE_ACTIONS.find((a) => a.operationId === id) as unknown as ActionRow | undefined;
    const ids = ["getSiteSettings", "updateSiteSettings", "inviteTeamMember", "removeTeamMember", "connectCustomDomain", "getBillingSummary", "updatePipelineConfig", "planContentGap"];
    check(
      "every MCP-3 route lands in ACTIONS and none becomes an individual tool",
      ids.every((id) => row(id)?.surface === "action") && ids.every((id) => !fixtureModule.OPERATIONS.some((o) => o.operationId === id)),
      ids.filter((id) => !row(id)).join(", "),
    );
    check(
      "the MCP-2 tools are unchanged by the fixture",
      fixtureModule.OPERATIONS.length === OPERATIONS.length,
      `${fixtureModule.OPERATIONS.length} vs ${OPERATIONS.length}`,
    );
    check(
      "a new route under the Pipeline tag, with no marker, is an action in the pipeline area",
      row("updatePipelineConfig")?.area === "pipeline" && fixtureModule.ACTION_AREAS.includes("pipeline"),
    );
    check(
      "team, money and pipeline approvals are ALWAYS (decision 6); the MCP-2 content removals stay switchable",
      row("inviteTeamMember")?.approvalMode === "always" && row("connectCustomDomain")?.approvalMode === "always" &&
        row("updatePipelineConfig")?.approvalMode === "always" &&
        fixtureModule.OPERATIONS.filter((o) => o.approval && /\.(delete|unpublish)$/.test(o.approval)).every((o) => o.approvalMode === "switchable") &&
        fixtureModule.OPERATIONS.filter((o) => o.approval === "pipeline.run").every((o) => o.approvalMode === "always"),
    );
    check(
      "x-writavo-approval-when is carried, and said in the description",
      (row("updatePipelineConfig") as unknown as { approvalWhen?: string })?.approvalWhen === "Asked only when the change makes the pipeline do more." &&
        /approval_id\. Asked only when the change makes the pipeline do more\./.test(row("updatePipelineConfig")?.description ?? ""),
      row("updatePipelineConfig")?.description.slice(-300),
    );
    const staysSwitchable = generate(withFixture((spec) => {
      (spec.paths["/team/members/{user_id}"]!.delete as Record<string, unknown>)["x-writavo-approval-always"] = false;
    }));
    const switchSource = existsSync(generatedFile) ? readFileSync(generatedFile, "utf8") : "";
    const removeRow = switchSource.slice(switchSource.indexOf('"operationId": "removeTeamMember"'));
    check(
      "x-writavo-approval-always: false makes an approval switchable",
      staysSwitchable.status === 0 && /"approvalMode": "switchable"/.test(removeRow.slice(0, removeRow.indexOf('"annotations"'))),
      staysSwitchable.stderr.slice(0, 200),
    );
    check(
      "x-spends-money asks first as a spend, and says COSTS MONEY with the consequence",
      row("connectCustomDomain")?.confirmReason === "spend" && row("connectCustomDomain")?.spendsMoney === true &&
        /COSTS MONEY: Costs 5 US dollars a month/.test(row("connectCustomDomain")?.description ?? ""),
      row("connectCustomDomain")?.description.slice(0, 300),
    );
    check(
      "x-agent-consequence replaces the content wording on a team DELETE",
      /PERMANENT: The member loses access/.test(row("removeTeamMember")?.description ?? "") &&
        !/deletes content/.test(row("removeTeamMember")?.description ?? ""),
      row("removeTeamMember")?.description.slice(0, 300),
    );
    check(
      "a settings write says which settings it changes, not that it changes content",
      /Changes Site settings\./.test(row("updateSiteSettings")?.description ?? "") && !/Changes content/.test(row("updateSiteSettings")?.description ?? ""),
      row("updateSiteSettings")?.description.slice(0, 300),
    );
    check(
      "x-also-scopes is carried and named",
      row("planContentGap")?.alsoScopes.join() === "plan:write" && /seo:write and plan:write scopes/.test(row("planContentGap")?.description ?? ""),
    );
    check(
      "an action's approval line tells the model to repeat run_writavo_action",
      /run_writavo_action again with the same operation_id/.test(row("inviteTeamMember")?.description ?? ""),
    );

    const refusedGen = (label: string, mutate: (spec: ReturnType<typeof base>) => void, expect: RegExp) => {
      const out = generate(withFixture(mutate));
      check(`the generator refuses ${label}`, out.status !== 0 && expect.test(out.stderr), `${out.status} ${out.stderr.slice(0, 300)}`);
    };
    refusedGen(
      "a gated action with no x-agent-consequence",
      (spec) => {
        delete (spec.paths["/team/invites"]!.post as Record<string, unknown>)["x-agent-consequence"];
      },
      /must carry x-agent-consequence/,
    );
    refusedGen(
      "x-spends-money with nothing saying what it costs",
      (spec) => {
        const get = spec.paths["/billing"]!.get as Record<string, unknown>;
        get["x-spends-money"] = true;
      },
      /x-spends-money needs an x-agent-consequence/,
    );
    refusedGen(
      "an x-mcp-surface value it does not know",
      (spec) => {
        (spec.paths["/billing"]!.get as Record<string, unknown>)["x-mcp-surface"] = "hidden";
      },
      /x-mcp-surface must be "tool" or "action"/,
    );
    const promoted = generate(withFixture((spec) => {
      (spec.paths["/billing"]!.get as Record<string, unknown>)["x-mcp-surface"] = "tool";
    }));
    const promotedSource = existsSync(generatedFile) ? readFileSync(generatedFile, "utf8") : "";
    check(
      "x-mcp-surface: tool on an operation makes it an individual tool, a decision recorded in the spec",
      promoted.status === 0 && promotedSource.includes('"tool": "get_billing_summary"') &&
        promotedSource.indexOf('"operationId": "getBillingSummary"') < promotedSource.indexOf("export const ACTIONS"),
      promoted.stderr.slice(0, 300),
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }

  if (FIXTURE_ACTIONS.length > 0) {
    // Search ranking, over the fixture catalog. No model, no network.
    const top = (query: string, area?: string) => searchActions(query, { area }, FIXTURE_ACTIONS)[0]?.operation.operationId;
    check("search: \"invite a team member\" finds inviteTeamMember first", top("invite a team member") === "inviteTeamMember", String(top("invite a team member")));
    check("search: \"custom domain\" finds connectCustomDomain first", top("custom domain") === "connectCustomDomain", String(top("custom domain")));
    const top3 = (query: string) => searchActions(query, {}, FIXTURE_ACTIONS).slice(0, 3).map((m) => m.operation.operationId);
    check("search: \"credit balance\" finds the billing summary first (a question favours reads)", top("credit balance") === "getBillingSummary", top3("credit balance").join(", "));
    if (FIXTURE_ACTIONS.some((a) => a.operationId === "trackKeyword") && FIXTURE_ACTIONS.some((a) => a.operationId === "listTrackedKeywords")) {
      check("search: \"track a keyword\" finds trackKeyword before the list (a write verb favours writes)", top("track a keyword") === "trackKeyword", top3("track a keyword").join(", "));
    }
    // The NEVER list is searchable, and it answers first with the dashboard step.
    for (const [query, what] of [
      ["change agent settings", "AI agent switch"],
      ["turn off approvals", "AI agent switch"],
      ["delete the site", "Delete a Site"],
      ["add a card", "payment details"],
      ["change plan", "Change the plan"],
      ["rotate an api key", "API keys"],
    ] as const) {
      const first = searchCatalog(query, {}, FIXTURE_ACTIONS)[0];
      check(
        `search: "${query}" answers with the NEVER entry first, and its next step`,
        first?.kind === "never" && first.never.what.includes(what) && /https:\/\/|start_plan_purchase/.test(first.never.next_step),
        JSON.stringify(first ?? {}).slice(0, 200),
      );
    }
    for (const query of ["change someone's role", "invoices", "wordpress", "update billing", "remove a member", "credit balance"]) {
      check(`search: "${query}" is not shadowed by a NEVER entry`, searchCatalog(query, {}, FIXTURE_ACTIONS)[0]?.kind === "action");
    }
    const neverText = bodyOf(handleSearchActions({ query: "add a card" }, FIXTURE_ACTIONS));
    check(
      "a NEVER result carries no operation_id, gives the link, and tells the model to stop there",
      neverText.includes('"never_through_an_agent"') && neverText.includes("billing?action=add-card") &&
        neverText.includes("do not try an operation instead") &&
        !/"operation_id"[^\n]*"never_through_an_agent"|"never_through_an_agent"[^\n]*"operation_id"/.test(neverText),
      neverText.slice(0, 400),
    );
    check("search: \"rename my site\" finds the settings update first", top("rename my site") === "updateSiteSettings", String(top("rename my site")));
    check("search: \"remove someone from the team\" finds removeTeamMember first", top("remove someone from the team") === "removeTeamMember", top3("remove someone from the team").join(", "));
    check("search: a question prefers reads (\"who is on the team\")", searchActions("who is on the team", {}, FIXTURE_ACTIONS)[0]?.operation.method === "GET", top3("who is on the team").join(", "));
    check("search: \"turn the pipeline on\" finds the pipeline configuration", top("turn the pipeline on") === "updatePipelineConfig", String(top("turn the pipeline on")));
    check("search: an exact operationId comes first", top("planContentGap") === "planContentGap");
    check(
      "search: an area filters, and an empty query lists the area",
      searchActions("", { area: "team" }, FIXTURE_ACTIONS).every((m) => m.operation.area === "team") &&
        searchActions("", { area: "team" }, FIXTURE_ACTIONS).length === Math.min(20, FIXTURE_ACTIONS.filter((a) => a.area === "team").length) &&
        searchActions("domain", { area: "billing" }, FIXTURE_ACTIONS).length === 0,
    );
    check("search: limit is honoured", searchActions("settings site team billing domain", { limit: 2 }, FIXTURE_ACTIONS).length <= 2);
    check("search: nothing matches nonsense", searchActions("zzqx plorb", {}, FIXTURE_ACTIONS).length === 0);

    const found = bodyOf(handleSearchActions({ query: "invite a team member", limit: 3 }, FIXTURE_ACTIONS));
    const parsed = JSON.parse(found.slice(found.indexOf("["), found.lastIndexOf("]") + 1)) as Record<string, unknown>[];
    const first = parsed[0] ?? {};
    const schema = first.input_schema as { required?: string[]; additionalProperties?: boolean; properties?: Record<string, { enum?: string[] }> } | undefined;
    check(
      "a search result carries operation_id, the call, scope, approval, spend and a compact input schema",
      first.operation_id === "inviteTeamMember" && first.call === "POST /team/invites" && first.needs_scope === "team:write" &&
        String(first.needs_approval).startsWith("always") && first.spends === "nothing" && first.asks_first === true &&
        schema?.additionalProperties === false && schema?.required?.join() === "email,role" &&
        schema?.properties?.role?.enum?.join() === "admin,editor,viewer" && !("Idempotency-Key" in (schema?.properties ?? {})),
      JSON.stringify(first).slice(0, 500),
    );
    const paid = JSON.parse(((s: string) => s.slice(s.indexOf("["), s.lastIndexOf("]") + 1))(bodyOf(handleSearchActions({ query: "custom domain", limit: 1 }, FIXTURE_ACTIONS)))) as Record<string, unknown>[];
    check("a paid action says it spends money, and its consequence", paid[0]?.spends === "money" && /5 US dollars/.test(String(paid[0]?.consequence)));
    check(
      "every search result names its runner: read_writavo_action for a GET, run_writavo_action otherwise",
      first.runner === "run_writavo_action" && paid[0]?.runner === "run_writavo_action" &&
        (JSON.parse(((s: string) => s.slice(s.indexOf("["), s.lastIndexOf("]") + 1))(bodyOf(handleSearchActions({ query: "billing summary", limit: 1 }, FIXTURE_ACTIONS)))) as Record<string, unknown>[])[0]?.runner === "read_writavo_action",
    );
    check("an unknown area is refused with the list", handleSearchActions({ query: "x", area: "nowhere" }, FIXTURE_ACTIONS).isError === true);
    check("an empty search is refused with the areas", handleSearchActions({ query: "  " }, FIXTURE_ACTIONS).isError === true);
    check("searching needs no key and makes no request", (() => { stub.reset(); handleSearchActions({ query: "domain" }, FIXTURE_ACTIONS); return stub.requests.length === 0; })());

    // Run: validation before anything is sent.
    currentKey = SECRET_KEY;
    stub.reset();
    stub.respond = () => ({ status: 200, body: { ok: true, data: { ok: "yes" } } });
    const run = (args: Record<string, unknown>) => handleRunAction(CTX, args, FIXTURE_ACTIONS);
    const badType = await run({ operation_id: "inviteTeamMember", arguments: { email: 5, role: "editor" }, confirm: true });
    const unknownField = await run({ operation_id: "inviteTeamMember", arguments: { email: "a@example.com", role: "editor", website_id: "x" }, confirm: true });
    const missing = await run({ operation_id: "inviteTeamMember", arguments: { role: "editor" }, confirm: true });
    const badEnum = await run({ operation_id: "inviteTeamMember", arguments: { email: "a@example.com", role: "owner" }, confirm: true });
    check(
      "run: a wrong type, an unknown field, a missing field and an enum outside the schema are all refused",
      [badType, unknownField, missing, badEnum].every((r) => r.isError === true && bodyOf(r).includes("Nothing was done")) &&
        bodyOf(badType).includes("- email:") && bodyOf(unknownField).includes("website_id") && bodyOf(missing).includes("- email:") &&
        bodyOf(badEnum).includes("- role:") && bodyOf(badEnum).includes('"input_schema"') === false && bodyOf(badEnum).includes('"required"'),
      [badType, unknownField, missing, badEnum].map((r) => bodyOf(r).slice(0, 120)).join(" | "),
    );
    check("run: nothing reached the API for any of them", stub.requests.length === 0);

    const notFound = await run({ operation_id: "deleteEverything" });
    const coreOp = await run({ operation_id: "deleteArticle", arguments: { id: "00000000-0000-4000-8000-000000000000" }, confirm: true });
    const refusedOp = REFUSALS.find((r) => r.tag === "API keys");
    const withheld = refusedOp ? await run({ operation_id: refusedOp.operationId }) : null;
    check(
      "run: an operationId outside the catalog is refused, a tool's is pointed at its tool, a withheld one gives its reason",
      notFound.isError === true && /no action "deleteEverything"/.test(bodyOf(notFound)) && bodyOf(notFound).includes("search_writavo_actions") &&
        coreOp.isError === true && bodyOf(coreOp).includes("delete_article") &&
        (withheld === null || (withheld.isError === true && /not available to an AI assistant/.test(bodyOf(withheld)))),
      [notFound, coreOp, withheld].map((r) => (r ? bodyOf(r).slice(0, 160) : "")).join(" | "),
    );
    check("run: none of those reached the API", stub.requests.length === 0);

    // Confirmation, exactly as a tool.
    const unconfirmed = await run({ operation_id: "connectCustomDomain", arguments: { hostname: "blog.example.com" } });
    check(
      "run: a paid action does nothing without confirm, states its consequence, and says how to repeat the call",
      stub.requests.length === 0 && bodyOf(unconfirmed).startsWith("Nothing has been done.") &&
        bodyOf(unconfirmed).includes("5 US dollars a month") && bodyOf(unconfirmed).includes('operation_id "connectCustomDomain"') &&
        bodyOf(unconfirmed).includes("confirm: true"),
      bodyOf(unconfirmed).slice(0, 400),
    );

    // Approval passthrough.
    stub.reset();
    stub.respond = () => ({
      status: 428,
      body: { ok: false, error: { code: "APPROVAL_REQUIRED", message: "A person has to approve this.", approval: { id: APPROVAL_ID, url: `https://app.writavo.com/approvals/${APPROVAL_ID}`, expires_at: null, status: "pending" } } },
    });
    const inviteArgs = { email: "new.person@example.com", role: "editor" };
    const parkedAction = await run({ operation_id: "inviteTeamMember", arguments: inviteArgs, confirm: true });
    const parkedText = bodyOf(parkedAction);
    check(
      "run: a 428 becomes the approval instruction, naming run_writavo_action and the operation",
      parkedAction.isError !== true && parkedText.startsWith("Nothing has been done yet.") &&
        parkedText.includes(`https://app.writavo.com/approvals/${APPROVAL_ID}`) && parkedText.includes(`approval_id: "${APPROVAL_ID}"`) &&
        parkedText.includes('run_writavo_action (operation_id "inviteTeamMember")') && !/\b428\b/.test(parkedText),
      parkedText.slice(0, 400),
    );
    const firstCall = stub.requests[0];
    check(
      "run: the request went to the operation's route, labelled run_writavo_action, with an Idempotency-Key and exactly the arguments",
      firstCall?.method === "POST" && firstCall.path === "/v1/team/invites" && firstCall.mcpTool === "run_writavo_action" &&
        firstCall.idempotencyKey !== null && firstCall.approval === null && JSON.stringify(JSON.parse(firstCall.body)) === JSON.stringify(inviteArgs),
      JSON.stringify(firstCall ?? {}).slice(0, 300),
    );
    stub.reset();
    stub.respond = () => ({ status: 201, body: { ok: true, data: { accept_url: "https://app.writavo.com/invite/abc" } } });
    const approvedRun = await run({ operation_id: "inviteTeamMember", arguments: inviteArgs, confirm: true, approval_id: APPROVAL_ID });
    check(
      "run: the retry sends Writavo-Approval with the same body, and returns the API's data",
      stub.requests[0]?.approval === APPROVAL_ID && stub.requests[0]?.body === firstCall?.body && bodyOf(approvedRun).includes("accept_url"),
      JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
    );
    stub.reset();
    await run({ operation_id: "invite_team_member", arguments: JSON.stringify({ ...inviteArgs, approval_id: APPROVAL_ID, confirm: true }) });
    check(
      "run: the snake-case name works, arguments may be JSON text, and confirm/approval_id inside arguments are lifted",
      stub.requests[0]?.approval === APPROVAL_ID && JSON.stringify(JSON.parse(stub.requests[0]?.body ?? "{}")) === JSON.stringify(inviteArgs),
      JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
    );
    stub.reset();
    const read = (args: Record<string, unknown>) => handleReadAction(CTX, args, FIXTURE_ACTIONS);
    const readViaRun = await run({ operation_id: "getBillingSummary" });
    const writeViaRead = await read({ operation_id: "inviteTeamMember", arguments: inviteArgs, confirm: true });
    check(
      "run_writavo_action refuses a GET and points to read_writavo_action; read_writavo_action refuses a write and points back",
      readViaRun.isError === true && bodyOf(readViaRun).includes("read_writavo_action") &&
        writeViaRead.isError === true && bodyOf(writeViaRead).includes("run_writavo_action") && stub.requests.length === 0,
      `${bodyOf(readViaRun).slice(0, 160)} | ${bodyOf(writeViaRead).slice(0, 160)}`,
    );
    stub.reset();
    const readOk = await read({ operation_id: "getBillingSummary" });
    check(
      "read_writavo_action runs a GET: no confirm, no Writavo-Approval, labelled read_writavo_action",
      readOk.isError !== true && stub.requests.length === 1 && stub.requests[0]?.method === "GET" && stub.requests[0]?.approval === null &&
        stub.requests[0]?.body === "" && stub.requests[0]?.mcpTool === "read_writavo_action",
      JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
    );
    stub.reset();
    const badLifted = await run({ operation_id: "inviteTeamMember", arguments: { ...inviteArgs, approval_id: "not-a-uuid\r\nX-Evil: 1" }, confirm: true });
    const badTop = await run({ operation_id: "inviteTeamMember", arguments: inviteArgs, confirm: true, approval_id: "12345" });
    check(
      "an approval_id that is not a UUID is refused, whether given at the top level or lifted from arguments",
      badLifted.isError === true && badTop.isError === true && bodyOf(badLifted).includes("UUID") && stub.requests.length === 0,
      `${bodyOf(badLifted).slice(0, 160)} | ${stub.requests.length}`,
    );
    stub.reset();
    await run({ operation_id: "removeTeamMember", arguments: { user_id: "22222222-3333-4444-8555-666666666666" }, confirm: true });
    check(
      "run: path arguments are filled into the route",
      stub.requests[0]?.method === "DELETE" && stub.requests[0]?.path === "/v1/team/members/22222222-3333-4444-8555-666666666666",
      JSON.stringify(stub.requests[0] ?? {}).slice(0, 200),
    );
    stub.reset();
    stub.respond = () => ({ status: 403, body: { ok: false, error: { code: "INSUFFICIENT_SCOPE", message: "This key does not carry the scope this operation needs." } } });
    const twoScopes = await run({ operation_id: "planContentGap", arguments: { id: "22222222-3333-4444-8555-666666666666" } });
    check(
      "run: INSUFFICIENT_SCOPE names both scopes an action needs",
      twoScopes.isError === true && bodyOf(twoScopes).includes("seo:write and plan:write"),
      bodyOf(twoScopes).slice(0, 300),
    );
    check(
      "run: INSUFFICIENT_SCOPE says where the person adds it, on the same connection and without signing in again",
      bodyOf(twoScopes).includes("On the sign-in screen this is: SEO, Read and write") && bodyOf(twoScopes).includes("without signing in again: Settings > AI agents"),
      bodyOf(twoScopes).slice(0, 900),
    );
    currentKey = null;
    stub.reset();
    const noKeyRun = await read({ operation_id: "getBillingSummary" });
    check("run: with no key it says how to sign in and sends nothing", noKeyRun.isError === true && stub.requests.length === 0);
    stub.respond = siteRespond;
  } else {
    check("the fixture catalog was generated", false, "the fixture generator produced no actions");
  }

  // The core registers the action tools, and the instructions point at them.
  {
    const remote2 = createWritavoMcpServer({ apiKey: () => SECRET_KEY, apiBase: baseUrl, userAgent: "writavo-mcp-smoke-worker/1.0", host: "remote" });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "writavo-mcp-smoke", version: "1.0.0" });
    await Promise.all([remote2.connect(s2), client2.connect(c2)]);
    const listed2 = (await client2.listTools()).tools;
    const search2 = listed2.find((t) => t.name === "search_writavo_actions");
    const run2 = listed2.find((t) => t.name === "run_writavo_action");
    const read2 = listed2.find((t) => t.name === "read_writavo_action");
    check(
      `the hosted core lists ${listed2.length} tools (43 expected here), including all three action tools`,
      listed2.length === OPERATIONS.length + CORE_LOCAL_TOOL_NAMES.length && Boolean(search2 && run2 && read2),
    );
    check(
      "read_writavo_action is read-only, not destructive and idempotent, and takes no approval_id or confirm",
      read2?.annotations?.readOnlyHint === true && read2?.annotations?.destructiveHint === false && read2?.annotations?.idempotentHint === true &&
        Object.keys((read2?.inputSchema as { properties?: object })?.properties ?? {}).join() === "operation_id,arguments",
    );
    check(
      "the hosted core lists search read-only and run not",
      search2?.annotations?.readOnlyHint === true && run2?.annotations?.readOnlyHint === false && run2?.annotations?.destructiveHint === true &&
        Object.keys((run2?.inputSchema as { properties?: object })?.properties ?? {}).join() === "operation_id,arguments,approval_id,confirm",
    );
    stub.reset();
    const viaMcp = await client2.callTool({ name: "search_writavo_actions", arguments: { query: "team member" } });
    check("search_writavo_actions answers through the protocol and sends no request", viaMcp.isError !== true && stub.requests.length === 0, JSON.stringify(viaMcp.content).slice(0, 200));
    const runUnknown = await client2.callTool({ name: "run_writavo_action", arguments: { operation_id: "doesNotExist" } });
    check("run_writavo_action refuses an unknown operation through the protocol", runUnknown.isError === true && stub.requests.length === 0);
    const instructions = client2.getInstructions() ?? "";
    check(
      `the hosted instructions (${instructions.length} characters) stay under 6000, name both tools and the never list`,
      instructions.length < 6000 && instructions.includes("search_writavo_actions") && instructions.includes("run_writavo_action") &&
        instructions.includes("read_writavo_action") && instructions.includes("never_through_an_agent") &&
        instructions.includes("NEVER through these tools") && instructions.includes("PREREQUISITE_MISSING"),
    );
    const shipped = [
      instructions,
      SEARCH_WRITAVO_ACTIONS.description,
      RUN_WRITAVO_ACTION.description,
      READ_WRITAVO_ACTION.description,
      ...REAL_ACTIONS.flatMap((a) => [a.description, a.summary, a.brief, ...a.params.map((p) => p.description)]),
      ...FIXTURE_ACTIONS.map((a) => a.description),
      ...surfaceModule.NEVER_ACTIONS.flatMap((n) => [n.what, n.why, n.next_step]),
    ];
    check(`no em-dash or en-dash in ${shipped.length} MCP-3 strings`, !shipped.some((s) => /[—–]/.test(s)), shipped.find((s) => /[—–]/.test(s))?.slice(0, 120) ?? "");
    await client2.close();
  }

  await stub.close();

  console.log("\n================================================");
  const failed = checks.filter((c) => !c.ok);
  console.log(`  ${checks.length - failed.length} passed, ${failed.length} failed, ${checks.length} total`);
  console.log("================================================");
  if (failed.length > 0) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("the smoke runner crashed:", err);
  process.exit(2);
});
