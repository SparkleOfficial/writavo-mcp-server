/**
 * Writavo MCP server, smoke test.
 * =================================================================================
 *
 * Runs entirely offline. It covers every API-6 acceptance test that does not need a deployed API,
 * which at the time of writing is all of them except the live round trip:
 *
 *   1  the package builds and the generated surface is coherent
 *   2  a REAL MCP client handshake over stdio: initialize, tools/list, resources/list,
 *      prompts/list, tools/call, with every stdout frame asserted to be a protocol message
 *   4  the no-key experience, with the real links
 *   5  the scope probe: a publishable key naming the scope it lacks
 *   6  the credit probe: an exhausted balance producing an actionable message with a billing link
 *   7  the confirmation probe, asserted by counting requests that reached the API (zero)
 *   8  the leak probe, including an API that echoes the key back in an error
 *  10  the em-dash ban across every user-visible string
 *  11  the saved sign-in: file permissions, round trip, expiry and precedence
 *  12  browser sign-in end to end against a stub: start, poll, approve, key in use, logout
 *  13  the plan purchase link
 *  14  the importer: validation, dry run, apply, re-run as a no-op, update, and content kept
 *      verbatim except for re-hosted image URLs
 *  15  MCP-2: the runtime-agnostic core as the hosted server mounts it (the tool list minus the
 *      sign-in tools, annotations on every tool, inline import and base64 upload), approvals
 *      (approval_id on gated tools, a 428 turned into an instruction, the refusal codes), the
 *      Writavo-Mcp-Tool header, logout revoking the key, the key auto-extension, the generator's
 *      handling of x-writavo-approval and of the host-owned /auth/key/* routes, and the core's
 *      import graph staying free of the filesystem and the environment
 *  16  MCP-3: the actions catalog (a fixture specification through the real generator), the
 *      search ranking, run_writavo_action's schema validation, unknown-operation refusal, the
 *      confirmation step and the approval passthrough, both hosts, and the new instructions
 *
 * The live round trip is scripts/integration.ts, which needs a real key and a deployed API.
 *
 *   pnpm --filter @writavo/mcp-server smoke
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

// upload_media and import_content fetch images from URLs the caller names, which is exactly what
// openWorldHint describes. Every other tool only ever talks to the Writavo API.
const OPEN_WORLD_TOOLS = new Set(["upload_media", "import_content"]);

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const ENTRYPOINT = join(PACKAGE_ROOT, "dist", "index.js");

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
// A stub API on loopback. The server only accepts a base URL override for a loopback address,
// which is the point: this harness can exist without opening a route for a key to be sent
// anywhere else.
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
// A real MCP client, speaking the protocol over stdio to the real entrypoint.
// ---------------------------------------------------------------------------
interface RpcMessage {
  jsonrpc?: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  method?: string;
}

async function clientProbe(): Promise<void> {
  console.log("\n[ 2. A real MCP client over stdio, no key configured ]");

  const child = spawn(process.execPath, [ENTRYPOINT], {
    stdio: ["pipe", "pipe", "pipe"],
    // Deliberately no WRITAVO_API_KEY: the tool list must load for someone who has not signed up.
    env: { ...process.env, WRITAVO_API_KEY: "", WRITAVO_API_BASE_URL: "" },
  });

  const frames: RpcMessage[] = [];
  const badLines: string[] = [];
  let stderr = "";
  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        frames.push(JSON.parse(line) as RpcMessage);
      } catch {
        // API-6 non-negotiable 2: on a stdio server, anything on stdout that is not a protocol
        // message breaks the connection. A line that does not parse is the whole failure mode.
        badLines.push(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const send = (message: Record<string, unknown>): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const waitFor = (id: number, timeoutMs = 15_000): Promise<RpcMessage> =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        const found = frames.find((f) => f.id === id);
        if (found) {
          clearInterval(poll);
          resolve(found);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`no reply to request ${id} within ${timeoutMs}ms. stderr: ${stderr.slice(0, 400)}`));
        } else if (child.exitCode !== null) {
          clearInterval(poll);
          reject(new Error(`the server exited with code ${child.exitCode}. stderr: ${stderr.slice(0, 400)}`));
        }
      }, 25);
    });

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "writavo-mcp-smoke", version: "1.0.0" },
      },
    });
    const initialized = await waitFor(1);
    check(
      "the server completes the MCP initialize handshake",
      Boolean(initialized.result?.serverInfo),
      JSON.stringify(initialized).slice(0, 300),
    );
    const serverInfo = initialized.result?.serverInfo as { name?: string; version?: string } | undefined;
    check("it identifies itself as writavo with a version", serverInfo?.name === "writavo" && Boolean(serverInfo?.version));
    const stdioInstructions = String((initialized.result as { instructions?: string } | undefined)?.instructions ?? "");
    check(
      `the stdio instructions (${stdioInstructions.length} characters) stay under 6000, point at the actions and carry no dashes`,
      stdioInstructions.length > 0 && stdioInstructions.length < 6000 && stdioInstructions.includes("search_writavo_actions") &&
        stdioInstructions.includes("run_writavo_action") && stdioInstructions.includes("read_writavo_action") && !/[\u2014\u2013]/.test(stdioInstructions),
    );

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor(2);
    const tools = (listed.result?.tools ?? []) as {
      name: string;
      description: string;
      inputSchema: { properties?: Record<string, unknown> };
      annotations?: Record<string, unknown>;
    }[];
    const { OPERATIONS } = await import("../src/generated/operations.js");
    const { LOCAL_TOOL_NAMES } = await import("../src/server.js");
    check(
      `the tool list loads: ${tools.length} tools`,
      tools.length === OPERATIONS.length + LOCAL_TOOL_NAMES.length,
      `expected ${OPERATIONS.length + LOCAL_TOOL_NAMES.length} (${OPERATIONS.length} generated plus ${LOCAL_TOOL_NAMES.join(", ")}), got ${tools.length}`,
    );
    check(
      "every hand-written tool is listed",
      LOCAL_TOOL_NAMES.every((name) => tools.some((t) => t.name === name)),
      LOCAL_TOOL_NAMES.filter((name) => !tools.some((t) => t.name === name)).join(", "),
    );
    check(
      "every tool carries a description and an input schema",
      tools.every((t) => t.description && t.description.length > 40 && t.inputSchema),
      tools.filter((t) => !t.description || t.description.length <= 40).map((t) => t.name).join(", "),
    );

    check(
      "every stdio tool carries annotations",
      tools.every((t) => typeof t.annotations?.readOnlyHint === "boolean" && t.annotations?.openWorldHint === OPEN_WORLD_TOOLS.has(t.name)),
      tools.filter((t) => !t.annotations).map((t) => t.name).join(", "),
    );
    const props = (name: string) => Object.keys(tools.find((t) => t.name === name)?.inputSchema?.properties ?? {});
    check(
      "the stdio import_content and upload_media also take a local path",
      ["data", "path"].every((p) => props("import_content").includes(p)) && ["path", "url", "base64"].every((p) => props("upload_media").includes(p)),
      `${props("import_content").join(",")} | ${props("upload_media").join(",")}`,
    );

    send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    const resources = ((await waitFor(3)).result?.resources ?? []) as { uri: string }[];
    check(
      "the four resources are listed, including the import format",
      resources.length === 4 && resources.some((r) => r.uri === "writavo://import-format"),
      resources.map((r) => r.uri).join(", "),
    );

    send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    const prompts = ((await waitFor(4)).result?.prompts ?? []) as { name: string }[];
    check(
      "all three prompts are listed",
      prompts.length === 3 &&
        ["draft-article", "publish-checklist", "migrate-content"].every((name) => prompts.some((p) => p.name === name)),
      prompts.map((p) => p.name).join(", "),
    );

    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "get_api_docs", arguments: { section: "overview" } },
    });
    const docs = await waitFor(5);
    const docsText = JSON.stringify(docs.result ?? {});
    check(
      "get_api_docs answers with no key configured",
      docs.result?.isError !== true && docsText.includes("Writavo Content API"),
      docsText.slice(0, 300),
    );

    send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "list_articles", arguments: {} },
    });
    const refused = await waitFor(6);
    const refusedText = JSON.stringify(refused.result ?? {});
    check(
      "a key-requiring tool returns the actionable no-key message",
      refused.result?.isError === true &&
        refusedText.includes("app.writavo.com/settings/api-keys") &&
        refusedText.includes("app.writavo.com/signup"),
      refusedText.slice(0, 400),
    );

    send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "login_status", arguments: {} } });
    const status = JSON.stringify((await waitFor(7)).result ?? {});
    check("login_status answers with no key: not signed in", status.includes("Not signed in"), status.slice(0, 200));

    send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "import_content", arguments: {} } });
    const format = await waitFor(8);
    const formatText = JSON.stringify(format.result ?? {});
    check(
      "import_content with no file describes the format, with no key",
      format.result?.isError !== true && formatText.includes("writavo-import") && formatText.includes("JSON Schema"),
      formatText.slice(0, 200),
    );

    send({ jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "writavo://import-format" } });
    const resource = JSON.stringify((await waitFor(9)).result ?? {});
    check("the import format resource reads", resource.includes("external_id") && resource.includes("json-schema.org/draft/2020-12"), resource.slice(0, 200));

    // Everything above ran on one connection. If a stray write had corrupted the stream the
    // requests after it would never have been answered.
    check("nothing extraneous was written to stdout", badLines.length === 0, badLines.slice(0, 3).join(" | "));
    check(
      "every stdout frame is a JSON-RPC message",
      frames.every((f) => f.jsonrpc === "2.0"),
      JSON.stringify(frames.filter((f) => f.jsonrpc !== "2.0")).slice(0, 200),
    );
    check("the client is still connected after nine exchanges", child.exitCode === null);
    check("no key material appeared on stderr", !/wv_(sk|pub)_[A-Za-z0-9]/.test(stderr), stderr.slice(0, 200));
  } finally {
    child.kill();
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("================================================");
  console.log("  Writavo MCP server, smoke test (offline)");
  console.log("================================================");

  if (!existsSync(ENTRYPOINT)) {
    console.error(`\nBuild first: no ${ENTRYPOINT}. Run \`pnpm --filter @writavo/mcp-server build\`.`);
    process.exit(2);
  }

  // The stub has to exist before the modules under test are imported, because the base URL is read
  // once at import time and cannot be changed afterwards. That is the property being relied on.
  const stub = new StubApi();
  const baseUrl = await stub.listen();
  process.env.WRITAVO_API_BASE_URL = baseUrl;
  process.env.WRITAVO_API_KEY = "";
  // A private config directory, so a real saved sign-in on this machine is never read, used or
  // overwritten by the test. Every child process below inherits it.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "writavo-mcp-smoke-"));

  const { CONFIG, redact, NO_API_KEY_MESSAGE, activateKey, clearKey } = await import("../src/config.js");
  const { OPERATIONS, REFUSALS } = await import("../src/generated/operations.js");
  const { ERROR_CATALOG } = await import("../src/generated/errors.js");
  const { REFERENCE_SECTIONS } = await import("../src/generated/reference.js");
  const { callOperation } = await import("../src/tools/call.js");
  const { STDIO_CONTEXT } = await import("../src/stdio/context.js");
  const { IMPORT_FILES, MEDIA_FILES } = await import("../src/stdio/files.js");
  const { handleGetApiDocs } = await import("../src/tools/api-docs.js");
  const { handleUploadMedia } = await import("../src/tools/upload-media.js");
  const { inputShapeFor } = await import("../src/tools/schema.js");
  const { keySource, hasApiKey, loginIdentity } = await import("../src/config.js");
  const { LOGIN, LOGIN_STATUS, LOGOUT, handleLogin, handleLoginStatus, handleLogout } = await import("../src/tools/login.js");
  const { START_PLAN_PURCHASE, handleStartPlanPurchase } = await import("../src/tools/plan-purchase.js");
  const { IMPORT_CONTENT, handleImportContent, importContentTool } = await import("../src/tools/import-content.js");
  const { UPLOAD_MEDIA, uploadMediaTool } = await import("../src/tools/upload-media.js");
  const { NOT_SIGNED_IN_REMOTE } = await import("../src/core/messages.js");
  const { DEFAULT_SCOPES } = await import("../src/auth/device.js");
  const { credentialsPath, deleteCredentials, readCredentials, writeCredentials } = await import("../src/credentials.js");
  const { IMPORT_FORMAT_GUIDE, IMPORT_SAMPLE, ImportDocumentSchema, importFormatJsonSchema } = await import("../src/import/format.js");
  const { migrateContentPrompt } = await import("../src/prompts/migrate-content.js");

  const bodyOf = (result: { content?: { text?: string }[] }): string =>
    (result.content ?? []).map((c) => c.text ?? "").join("\n");
  const operation = (tool: string) => {
    const found = OPERATIONS.find((o) => o.tool === tool);
    if (!found) throw new Error(`no generated operation for ${tool}`);
    return found;
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
    NO_API_KEY_MESSAGE,
    ...[LOGIN, LOGIN_STATUS, LOGOUT, START_PLAN_PURCHASE, IMPORT_CONTENT, importContentTool(IMPORT_FILES), UPLOAD_MEDIA, uploadMediaTool(MEDIA_FILES)].map((t) => t.description),
    NOT_SIGNED_IN_REMOTE,
    migrateContentPrompt({}, "remote").messages[0]!.content.text,
    IMPORT_FORMAT_GUIDE,
    migrateContentPrompt({}).messages[0]!.content.text,
  ];
  const withDash = userVisible.filter((s) => /[—–]/.test(s));
  check(`10. no em-dash or en-dash in ${userVisible.length} user-visible strings`, withDash.length === 0, withDash[0]?.slice(0, 120) ?? "");

  // -- 4. the no-key experience ---------------------------------------------
  console.log("\n[ 4. The no-key experience ]");
  clearKey();
  stub.reset();
  const noKey = await callOperation(STDIO_CONTEXT, operation("list_articles"), {});
  check(
    "a key-requiring tool explains how to get a key",
    noKey.isError === true &&
      bodyOf(noKey).includes("app.writavo.com/settings/api-keys") &&
      bodyOf(noKey).includes('"WRITAVO_API_KEY": "wv_sk_your_key_here"'),
    bodyOf(noKey).slice(0, 200),
  );
  check("it made no request at all", stub.requests.length === 0);
  check("get_api_docs still works", !handleGetApiDocs({ section: "authentication" }).isError);
  check(
    "upload_media explains the same thing",
    (await handleUploadMedia(STDIO_CONTEXT, { path: "/tmp/x.png" }, MEDIA_FILES)).isError === true,
  );

  // -- 5. the scope probe ----------------------------------------------------
  console.log("\n[ 5. The scope probe ]");
  activateKey(PUBLISHABLE_KEY, "env");
  stub.reset();
  const scoped = await callOperation(STDIO_CONTEXT, operation("publish_article"), { id: "00000000-0000-4000-8000-000000000000", confirm: true });
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
  activateKey(SECRET_KEY, "env");
  stub.reset();
  stub.respond = () => ({
    status: 403,
    body: { ok: false, error: { code: "INSUFFICIENT_SCOPE", message: "This key does not carry the scope this operation needs." } },
  });
  const apiScope = await callOperation(STDIO_CONTEXT, operation("list_media"), {});
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
  const credits = await callOperation(STDIO_CONTEXT, operation("trigger_pipeline_run"), { confirm: true });
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
  const entitlement = await callOperation(STDIO_CONTEXT, operation("trigger_pipeline_run"), { confirm: true });
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
    const unconfirmed = await callOperation(STDIO_CONTEXT, op, { id: "00000000-0000-4000-8000-000000000000", scheduled_publish_at: "2030-01-01T00:00:00Z" });
    const body = bodyOf(unconfirmed);
    check(
      `${tool} does nothing without confirm: true`,
      stub.requests.length === 0 && body.startsWith("Nothing has been done.") && body.includes("confirm: true"),
      `${stub.requests.length} request(s) reached the API. ${body.slice(0, 160)}`,
    );
  }
  stub.reset();
  const confirmed = await callOperation(STDIO_CONTEXT, operation("publish_article"), { id: "00000000-0000-4000-8000-000000000000", confirm: true });
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
  transcript.push(bodyOf(await callOperation(STDIO_CONTEXT, operation("list_articles"), {})));
  transcript.push(bodyOf(await callOperation(STDIO_CONTEXT, operation("get_article"), { id: "00000000-0000-4000-8000-000000000000" })));
  stub.respond = () => ({ status: 200, body: { ok: true, data: { echo: SECRET_KEY } } });
  transcript.push(bodyOf(await callOperation(STDIO_CONTEXT, operation("get_usage"), {})));
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

  // -- 11. the saved sign-in ------------------------------------------------
  console.log("\n[ 11. The saved sign-in ]");
  const configHome = process.env.XDG_CONFIG_HOME as string;
  const modeOf = (path: string) => statSync(path).mode & 0o777;
  const fileKey = `wv_sk_${"c".repeat(32)}`;
  const credentials = {
    version: 1 as const,
    api_key: fileKey,
    key_id: "00000000-0000-4000-8000-00000000c0de",
    key_prefix: fileKey.slice(0, 12),
    website: { id: "00000000-0000-4000-8000-0000000051e0", name: "Saved Site" },
    scopes: ["articles:read"],
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: new Date().toISOString(),
  };
  const credsFile = writeCredentials(credentials);
  check("it is written under XDG_CONFIG_HOME/writavo", credsFile === join(configHome, "writavo", "credentials.json") && credsFile === credentialsPath());
  check("the file is 0600", modeOf(credsFile) === 0o600, modeOf(credsFile).toString(8));
  check("its directory is 0700", modeOf(dirname(credsFile)) === 0o700, modeOf(dirname(credsFile)).toString(8));
  const readBack = readCredentials();
  check("it reads back as a valid sign-in", readBack.state === "valid" && readBack.credentials.api_key === fileKey, readBack.state);
  writeCredentials({ ...credentials, expires_at: new Date(Date.now() - 1000).toISOString() });
  check("a past expires_at reads as expired", readCredentials().state === "expired");
  check("a rewrite keeps the file 0600", modeOf(credsFile) === 0o600);
  writeFileSync(credsFile, "{ not json");
  check("a damaged file reads as invalid, not as a key", readCredentials().state === "invalid");
  check("delete removes it", deleteCredentials() === true && !existsSync(credsFile));
  check("a second delete reports there was nothing", deleteCredentials() === false);

  // Precedence is decided at start up, so it is probed in fresh processes against the build.
  const probeConfig = (env: Record<string, string>, expect: string) =>
    new Promise<{ source?: string; key?: string; message?: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "import('./dist/config.js').then(m => { const k = m.apiKey(); process.stderr.write(JSON.stringify({ source: m.keySource(), key: k === process.env.EXPECT ? 'expected' : (k ? 'other' : 'none'), message: m.noKeyMessage().slice(0, 300) })) })",
        ],
        { cwd: PACKAGE_ROOT, env: { ...process.env, WRITAVO_API_BASE_URL: "", EXPECT: expect, ...env } },
      );
      let out = "";
      child.stderr.on("data", (c: Buffer) => {
        out += c.toString();
      });
      child.on("close", () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({ message: out });
        }
      });
    });
  const homeWith = (expiresAt: string) => {
    const home = mkdtempSync(join(tmpdir(), "writavo-mcp-smoke-home-"));
    process.env.XDG_CONFIG_HOME = home;
    writeCredentials({ ...credentials, expires_at: expiresAt });
    process.env.XDG_CONFIG_HOME = configHome;
    return home;
  };
  const validHome = homeWith(new Date(Date.now() + 86_400_000).toISOString());
  const fromFile = await probeConfig({ XDG_CONFIG_HOME: validHome, WRITAVO_API_KEY: "" }, fileKey);
  check("with no env key, the saved sign-in is used", fromFile.source === "login" && fromFile.key === "expected", JSON.stringify(fromFile));
  const fromEnv = await probeConfig({ XDG_CONFIG_HOME: validHome, WRITAVO_API_KEY: SECRET_KEY }, SECRET_KEY);
  check("WRITAVO_API_KEY outranks the saved sign-in", fromEnv.source === "env" && fromEnv.key === "expected", JSON.stringify(fromEnv));
  const expiredHome = homeWith(new Date(Date.now() - 1000).toISOString());
  const fromExpired = await probeConfig({ XDG_CONFIG_HOME: expiredHome, WRITAVO_API_KEY: "" }, fileKey);
  check(
    "an expired sign-in is treated as signed out, and says so",
    fromExpired.source === "none" && fromExpired.key === "none" && /expired/.test(fromExpired.message ?? "") && /login/.test(fromExpired.message ?? ""),
    JSON.stringify(fromExpired),
  );

  // -- a Site in memory, behind the stub --------------------------------------
  // Enough of the API for sign-in, billing and the importer to run against: taxonomy, articles
  // with external_id, idempotent creates, publish with original dates, the upload handshake.
  type Row = Record<string, unknown>;
  const site = {
    categories: [] as Row[],
    tags: [{ id: "00000000-0000-4000-8000-00000000c0c0", slug: "compost", name: "Compost" }] as Row[],
    authors: [] as Row[],
    articles: [] as Row[],
    replays: new Map<string, { status: number; body: unknown }>(),
  };
  const device = { mode: "approve" as "approve" | "deny", polls: 0, started: [] as Row[] };
  const keyRoutes = { revoke: "ok" as "ok" | "fail", extendTo: null as string | null };
  const ok = (data: unknown, status = 200) => ({ status, body: { ok: true, data } });
  const fail = (status: number, code: string, message: string) => ({ status, body: { ok: false, error: { code, message } } });
  const project = (row: Row, fields: string | null): Row =>
    fields ? Object.fromEntries(fields.split(",").map((f) => [f, row[f] ?? null])) : row;
  const siteRespond = (req: StubRequest): { status: number; body: unknown } => {
    const url = new URL(req.path, "http://stub");
    const path = url.pathname.replace(/^\/v1/, "");
    const q = url.searchParams;
    const body = (req.body ? JSON.parse(req.body) : {}) as Row;

    if (path === "/auth/device" && req.method === "POST") {
      device.started.push(body);
      device.polls = 0;
      return ok(
        {
          device_code: `dc_${randomUUID()}`,
          user_code: "BCDF-GHJK",
          verification_uri: "https://app.writavo.com/device",
          verification_uri_complete: "https://app.writavo.com/device?code=BCDF-GHJK",
          expires_in: 1800,
          interval: 1,
        },
        201,
      );
    }
    if (path === "/auth/device/token" && req.method === "POST") {
      device.polls += 1;
      if (device.polls < 2) return ok({ status: "pending" });
      if (device.mode === "deny") return ok({ status: "denied" });
      const started = device.started[device.started.length - 1]!;
      return ok({
        status: "approved",
        key: {
          id: "00000000-0000-4000-8000-0000000000aa",
          key_prefix: started.key_prefix,
          scopes: started.scopes,
          expires_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
        },
        website: { id: "00000000-0000-4000-8000-0000000051e1", name: "Smoke Site" },
      });
    }
    if (path === "/auth/key/revoke" && req.method === "POST") {
      return keyRoutes.revoke === "ok" ? ok({ revoked: true }) : fail(503, "MAINTENANCE", "Down for a moment.");
    }
    if (path === "/auth/key/extend" && req.method === "POST") {
      return keyRoutes.extendTo
        ? ok({ key: { id: "00000000-0000-4000-8000-0000000000aa", expires_at: keyRoutes.extendTo }, extended: true })
        : ok({ key: { id: "00000000-0000-4000-8000-0000000000aa", expires_at: null }, extended: false, reason: "max_lifetime" });
    }
    if (req.method === "GET" && path === "/site") return ok({ id: "00000000-0000-4000-8000-0000000051e1", name: "Smoke Site" });
    if (req.method === "GET" && path === "/usage") {
      return ok({ plan: { key: "free", name: "Free" }, limits: [{ key: "documents", limit: 10000, used: 5 }], credits: { balance: 0 } });
    }
    if (req.method === "GET" && path === "/content-types") {
      return ok({ items: [{ id: "00000000-0000-4000-8000-00000000f0f0", key: "how_to", name: "How-To", is_active: true }] });
    }
    for (const kind of ["categories", "tags", "authors"] as const) {
      if (path !== `/${kind}`) continue;
      if (req.method === "GET") return ok({ items: site[kind], next_cursor: null });
      if (req.method === "POST") {
        if (kind !== "authors" && site[kind].some((r) => r.slug === body.slug)) return fail(409, "SLUG_CONFLICT", "That slug is taken.");
        const row = { id: randomUUID(), ...body };
        site[kind].push(row);
        return ok(row, 201);
      }
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
    const one = /^\/articles\/([^/]+)(\/publish)?$/.exec(path);
    if (one) {
      const row = site.articles.find((a) => a.id === one[1]);
      if (!row) return fail(404, "NOT_FOUND", "No such article.");
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
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
  const leakTranscript: string[] = [];

  // -- 12. browser sign-in ---------------------------------------------------
  console.log("\n[ 12. Browser sign-in ]");
  clearKey();
  stub.reset();
  stub.respond = siteRespond;
  device.mode = "approve";
  const started = bodyOf(await handleLogin({}));
  leakTranscript.push(started);
  check(
    "login returns the link and the code to show the user",
    started.includes("https://app.writavo.com/device?code=BCDF-GHJK") && started.includes("BCDF-GHJK") && started.includes("login_status"),
    started.slice(0, 300),
  );
  check("it tells a new user to finish onboarding and how to bring articles", started.includes("onboarding") && started.includes("Bring my existing articles"));
  const startRequest = stub.requests.find((r) => r.path.endsWith("/auth/device"));
  const startBody = JSON.parse(startRequest?.body ?? "{}") as Row;
  check("the sign-in request carries no API key", startRequest !== undefined && !startRequest.hasAuth);
  check(
    "it sends only the hash and a 12 character prefix of the secret",
    /^[0-9a-f]{64}$/.test(String(startBody.key_hash)) && /^wv_sk_[A-Za-z0-9_-]{6}$/.test(String(startBody.key_prefix)) && !("api_key" in startBody),
    JSON.stringify(startBody).slice(0, 200),
  );
  check(
    "it asks for the default scopes, never keys or webhooks",
    JSON.stringify(startBody.scopes) === JSON.stringify(DEFAULT_SCOPES) && !JSON.stringify(startBody.scopes).match(/keys:|webhooks:/),
  );
  check(
    "with no handshake name yet, the key is named for an AI assistant on this machine",
    startBody.client_name === "AI assistant (local MCP)" && typeof startBody.client_host === "string" && String(startBody.client_host).length > 0,
    JSON.stringify({ client_name: startBody.client_name, client_host: startBody.client_host }),
  );
  check("nothing is saved or in use while it is pending", !existsSync(credentialsPath()) && !hasApiKey());

  const approved = await waitUntil(() => bodyOf(handleLoginStatus()).startsWith("Approved"));
  const statusText = bodyOf(handleLoginStatus());
  leakTranscript.push(statusText);
  check("the background poll picks up the approval", approved, statusText.slice(0, 200));
  check("login_status names the Site and the scopes", statusText.includes("Smoke Site") && statusText.includes("articles:write"));
  const savedLogin = existsSync(credentialsPath()) ? (JSON.parse(readFileSync(credentialsPath(), "utf8")) as Row) : {};
  check(
    "the saved key is the secret whose hash was approved",
    typeof savedLogin.api_key === "string" && sha256(savedLogin.api_key) === startBody.key_hash,
  );
  check("the saved file is 0600", existsSync(credentialsPath()) && modeOf(credentialsPath()) === 0o600);
  check("the saved file names the Site", (savedLogin.website as Row | undefined)?.name === "Smoke Site");
  check("the key is in use at once, with no restart", keySource() === "login" && hasApiKey());
  stub.reset();
  leakTranscript.push(bodyOf(await callOperation(STDIO_CONTEXT, operation("get_site_info"), {})));
  check("the next tool call sends the new key", stub.requests[0]?.authorization === `Bearer ${String(savedLogin.api_key)}`);

  stub.reset();
  const again = bodyOf(await handleLogin({}));
  leakTranscript.push(again);
  check(
    "a second login says it is already signed in, names the Site, and starts nothing",
    again.includes("Already signed in") && again.includes("Smoke Site") && again.includes("force: true") && stub.requests.length === 0,
    again.slice(0, 200),
  );

  stub.reset();
  const loggedOut = bodyOf(await handleLogout());
  leakTranscript.push(loggedOut);
  const revokeCall = stub.requests.find((r) => r.path.endsWith("/auth/key/revoke"));
  check(
    "logout revokes the key on Writavo first, authenticated as that key",
    revokeCall !== undefined && revokeCall.method === "POST" && revokeCall.authorization === `Bearer ${String(savedLogin.api_key)}`,
    stub.requests.map((r) => `${r.method} ${r.path}`).join(", "),
  );
  check("logout deletes the saved sign-in", !existsSync(credentialsPath()));
  check("logout stops using the key", !hasApiKey() && keySource() === "none");
  check("logout says the key was revoked", /was revoked on Writavo/.test(loggedOut), loggedOut.slice(0, 300));

  // A revoke that cannot reach Writavo still signs out locally, and says what to do by hand.
  writeCredentials({ ...credentials, api_key: fileKey, expires_at: new Date(Date.now() + 86_400_000).toISOString() });
  activateKey(fileKey, "login", { ...credentials, api_key: fileKey }, credentialsPath());
  keyRoutes.revoke = "fail";
  stub.reset();
  const failedLogout = bodyOf(await handleLogout());
  leakTranscript.push(failedLogout);
  keyRoutes.revoke = "ok";
  check(
    "a revoke that fails is reported, with where to revoke by hand, and the file is still deleted",
    /could NOT be revoked/.test(failedLogout) && failedLogout.includes("app.writavo.com/settings/api-keys") && !existsSync(credentialsPath()),
    failedLogout.slice(0, 300),
  );

  device.mode = "deny";
  stub.reset();
  leakTranscript.push(bodyOf(await handleLogin({})));
  const denied = await waitUntil(() => bodyOf(handleLoginStatus()).includes("denied"));
  leakTranscript.push(bodyOf(handleLoginStatus()));
  check("a denied request is reported as denied", denied);
  check("and nothing is saved or in use", !existsSync(credentialsPath()) && !hasApiKey());
  check(
    "no sign-in reply ever carries a key",
    !leakTranscript.some((t) => t.includes(String(savedLogin.api_key)) || /wv_sk_(?!REDACTED)[A-Za-z0-9_-]{20,}/.test(t)),
    leakTranscript.find((t) => /wv_sk_[A-Za-z0-9_-]{20,}/.test(t))?.slice(0, 200) ?? "",
  );

  // The key is named after the connected client, from the initialize handshake (Addendum B).
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

    // Through the real stdio server: a client that says it is claude-code gets a key named so.
    const { createServer: createStdioServer } = await import("../src/server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const stdioServer = createStdioServer();
    const [c, srv] = InMemoryTransport.createLinkedPair();
    const named = new Client({ name: "claude-code", version: "2.0.0" });
    await Promise.all([stdioServer.connect(srv), named.connect(c)]);
    clearKey();
    device.mode = "deny";
    stub.reset();
    await named.callTool({ name: "login", arguments: { force: true } });
    const namedStart = JSON.parse(stub.requests.find((r) => r.path.endsWith("/auth/device"))?.body ?? "{}") as Row;
    check(
      "login names the key after the connected client: Claude Code (local MCP), on this machine",
      namedStart.client_name === "Claude Code (local MCP)" && typeof namedStart.client_host === "string" && String(namedStart.client_host).length > 0,
      JSON.stringify({ client_name: namedStart.client_name, client_host: namedStart.client_host }),
    );
    await waitUntil(() => bodyOf(handleLoginStatus()).includes("denied"));
    await named.close();
  }

  // -- 13. the plan purchase link --------------------------------------------
  console.log("\n[ 13. The plan purchase link ]");
  clearKey();
  stub.reset();
  const planNoKey = bodyOf(await handleStartPlanPurchase(STDIO_CONTEXT, { plan: "growth", interval: "year" }));
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
  activateKey(SECRET_KEY, "env");
  const planWithKey = bodyOf(await handleStartPlanPurchase(STDIO_CONTEXT, {}));
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

  const workDir = mkdtempSync(join(tmpdir(), "writavo-mcp-import-"));
  const EM = "\u2014";
  const firstContent = `Intro ${EM} kept exactly as written, "quotes" and all.\n\n![A kit](https://img.example.test/a.png)\n\n![Old](http://insecure.example.test/b.png "legacy")\n\nThe end.`;
  const fixture = {
    format: "writavo-import",
    version: 1,
    authors: [{ ref: "jane", name: "Jane Doe", avatar_url: "https://img.example.test/jane.png" }],
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
  const fixturePath = join(workDir, "import.json");
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  const progressFile = `${fixturePath}.writavo-progress.json`;
  const importTranscript: string[] = [];

  // Validation: every problem surfaces against its own external_id, and nothing is written.
  const badPath = join(workDir, "bad.json");
  writeFileSync(
    badPath,
    JSON.stringify({
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
    }),
  );
  stub.reset();
  const invalid = bodyOf(await handleImportContent(STDIO_CONTEXT, { path: badPath }, IMPORT_FILES));
  importTranscript.push(invalid);
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
  check("a dry run writes no progress file", !existsSync(`${badPath}.writavo-progress.json`));

  stub.reset();
  const dry = bodyOf(await handleImportContent(STDIO_CONTEXT, { path: fixturePath }, IMPORT_FILES));
  importTranscript.push(dry);
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
  check("it names the next call, with confirm because it publishes", dry.includes('"dry_run":false') && dry.includes('"confirm":true'));
  check("and it wrote nothing, not even progress", writes().length === 0 && !existsSync(progressFile));

  stub.reset();
  const unconfirmed = bodyOf(await handleImportContent(STDIO_CONTEXT, { path: fixturePath, dry_run: false }, IMPORT_FILES));
  importTranscript.push(unconfirmed);
  check(
    "an import that publishes does nothing without confirm: true",
    unconfirmed.startsWith("Nothing has been done.") && writes().length === 0,
    unconfirmed.slice(0, 200),
  );

  stub.reset();
  const applied = bodyOf(await handleImportContent(STDIO_CONTEXT, { path: fixturePath, dry_run: false, confirm: true }, IMPORT_FILES));
  importTranscript.push(applied);
  check("the import completes in one batch", applied.includes("Import complete"), applied.slice(0, 600));
  const posts = (suffix: string) => writes().filter((r) => r.method === "POST" && r.path.replace(/\?.*$/, "").endsWith(suffix));
  check("missing taxonomy is created, existing taxonomy is matched", posts("/categories").length === 1 && posts("/tags").length === 1);
  const authorBody = JSON.parse(posts("/authors")[0]?.body ?? "{}") as Row;
  check(
    "the author is created as a real person, with a re-hosted avatar",
    authorBody.is_ai_generated === false && String(authorBody.avatar_url).startsWith("https://cdn.example.test/"),
    JSON.stringify(authorBody),
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
  check(
    "references resolve to the Site's ids",
    first.category_id === site.categories[0]?.id &&
      first.author_id === site.authors[0]?.id &&
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
  check("progress is saved next to the file", existsSync(progressFile));

  stub.reset();
  const rerun = bodyOf(await handleImportContent(STDIO_CONTEXT, { path: fixturePath, dry_run: false, confirm: true }, IMPORT_FILES));
  importTranscript.push(rerun);
  check(
    "running it again is a no-op",
    rerun.includes("Import complete") && writes().length === 0 && site.articles.length === 3,
    `${writes().length} writes: ${writes().map((r) => `${r.method} ${r.path}`).join(", ")}`,
  );

  fixture.articles[1] = { ...fixture.articles[1]!, title: "Winter notes, revised" };
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  stub.reset();
  const updated = bodyOf(await handleImportContent(STDIO_CONTEXT, { path: fixturePath, dry_run: false, confirm: true }, IMPORT_FILES));
  importTranscript.push(updated);
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
  check(
    "no import reply ever carries the key",
    !importTranscript.some((t) => t.includes(SECRET_KEY) || /wv_sk_(?!REDACTED)[A-Za-z0-9_-]{20,}/.test(t)),
  );

  // -- 15. MCP-2: the core, approvals, headers, key lifecycle ----------------
  console.log("\n[ 15. The remote-safe core, approvals and the key lifecycle ]");
  const { createWritavoMcpServer, CORE_LOCAL_TOOL_NAMES, VERSION } = await import("../src/core/index.js");
  const { STDIO_TOOL_NAMES } = await import("../src/server.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  // The version is one constant, and every file that states it agrees.
  const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
  const serverJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, "server.json"), "utf8")) as { version: string; packages: { version: string }[]; remotes?: { type: string; url: string }[] };
  const pluginJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, ".claude-plugin", "plugin.json"), "utf8")) as { version: string };
  check(
    `the version is ${VERSION} in the code, package.json, server.json and the Claude plugin`,
    VERSION === pkg.version && serverJson.version === pkg.version && serverJson.packages.every((p) => p.version === pkg.version) && pluginJson.version === pkg.version,
    `${VERSION} / ${pkg.version} / ${serverJson.version} / ${pluginJson.version}`,
  );
  check(
    "server.json lists the hosted server as a streamable-http remote",
    serverJson.remotes?.some((r) => r.type === "streamable-http" && r.url === "https://mcp.writavo.com/mcp") === true,
  );

  // The core as the Worker mounts it: a key from the grant, no filesystem, no login tools.
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
    STDIO_TOOL_NAMES.every((n) => !remoteTools.some((t) => t.name === n)),
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
  const parked = await callOperation(STDIO_CONTEXT, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true });
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
    const shown = bodyOf(await callOperation(STDIO_CONTEXT, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true }));
    check(
      `an approval link other than app.writavo.com/approvals/<id> is replaced: ${bad}`,
      !shown.includes(bad) && shown.includes(`https://app.writavo.com/approvals/${APPROVAL_ID}`),
      shown.slice(0, 300),
    );
  }
  stub.reset();
  stub.respond = () => ({ status: 200, body: { ok: true, data: { id: "x" } } });
  await callOperation(STDIO_CONTEXT, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true, approval_id: APPROVAL_ID });
  check(
    "the retry sends the approval as Writavo-Approval, with the tool name",
    stub.requests[0]?.approval === APPROVAL_ID && stub.requests[0]?.mcpTool === "delete_article",
    JSON.stringify(stub.requests[0] ?? {}).slice(0, 300),
  );
  stub.reset();
  await callOperation(STDIO_CONTEXT, { ...operation("delete_article"), approval: null }, { id: "00000000-0000-4000-8000-000000000000", confirm: true, approval_id: APPROVAL_ID });
  check("an ungated tool never sends Writavo-Approval", stub.requests[0]?.approval === null);

  const refusal = async (status: number, code: string) => {
    stub.respond = () => ({ status, body: { ok: false, error: { code, message: `The API said ${code}.` } } });
    return callOperation(STDIO_CONTEXT, gatedDelete, { id: "00000000-0000-4000-8000-000000000000", confirm: true, approval_id: APPROVAL_ID });
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
  await callOperation(STDIO_CONTEXT, operation("list_articles"), {});
  check(
    "every API request names its tool in Writavo-Mcp-Tool and the user agent carries the version",
    stub.requests[0]?.mcpTool === "list_articles" && stub.requests[0]?.userAgent === `writavo-mcp-server/${VERSION}`,
    JSON.stringify(stub.requests[0] ?? {}).slice(0, 200),
  );

  // The key auto-extension: only when due, at most once a day, and the file follows.
  const { extendSavedKeyIfDue } = await import("../src/stdio/key-lifecycle.js");
  const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const later = new Date(Date.now() + 90 * 86_400_000).toISOString();
  writeCredentials({ ...credentials, api_key: fileKey, expires_at: soon });
  activateKey(fileKey, "login", { ...credentials, api_key: fileKey, expires_at: soon }, credentialsPath());
  keyRoutes.extendTo = later;
  stub.reset();
  const extended = await extendSavedKeyIfDue();
  const afterExtend = readCredentials();
  check(
    "a saved key within 30 days of expiry is extended, with that key, and the file is rewritten",
    extended.state === "extended" &&
      stub.requests.some((r) => r.path.endsWith("/auth/key/extend") && r.authorization === `Bearer ${fileKey}`) &&
      afterExtend.state === "valid" && afterExtend.credentials.expires_at === later && Boolean(afterExtend.credentials.extend_checked_at),
    `${JSON.stringify(extended)} ${afterExtend.state}`,
  );
  check("the key in use carries the new expiry", loginIdentity()?.expiresAt === later);
  stub.reset();
  const notDue = await extendSavedKeyIfDue();
  check("a key with more than 30 days left is not sent at all", notDue.state === "skipped" && stub.requests.length === 0, JSON.stringify(notDue));
  writeCredentials({ ...credentials, api_key: fileKey, expires_at: soon, extend_checked_at: new Date().toISOString() });
  stub.reset();
  const twice = await extendSavedKeyIfDue();
  check("it asks at most once a day", twice.state === "skipped" && stub.requests.length === 0, JSON.stringify(twice));
  writeCredentials({ ...credentials, api_key: fileKey, expires_at: soon });
  keyRoutes.extendTo = null;
  const capped = await extendSavedKeyIfDue();
  check(
    "a key at its maximum lifetime is left as it is, and the check is recorded",
    capped.state === "unchanged" && readCredentials().state === "valid" && (readCredentials() as { credentials: { extend_checked_at?: string } }).credentials.extend_checked_at !== undefined,
    JSON.stringify(capped),
  );
  clearKey();
  deleteCredentials();

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

  // The core must run where there is no filesystem and no environment: walk what it imports.
  const coreGraph = new Set<string>();
  const forbidden: string[] = [];
  const walk = (file: string): void => {
    if (coreGraph.has(file)) return;
    coreGraph.add(file);
    // Comments may mention process.env or src/stdio; code may not.
    const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gms)) {
      const spec = m[1]!;
      if (/^node:(fs|os|child_process|net|http|https|worker_threads)/.test(spec)) forbidden.push(`${file.replace(PACKAGE_ROOT, "")} imports ${spec}`);
      if (spec.startsWith(".")) walk(join(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
    if (/process\.(env|argv|cwd|exit|platform)/.test(source)) forbidden.push(`${file.replace(PACKAGE_ROOT, "")} reads process`);
    if (/\/(config|credentials)\.js"|\/stdio\/|\/auth\/device\.js"|\/tools\/login\.js"/.test(source)) forbidden.push(`${file.replace(PACKAGE_ROOT, "")} imports a stdio-only module`);
  };
  walk(join(PACKAGE_ROOT, "src", "core", "index.ts"));
  check(
    `the core's ${coreGraph.size} modules touch no filesystem, no environment and no stdio-only module`,
    forbidden.length === 0 && coreGraph.size > 15,
    forbidden.join("; "),
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
    "search_writavo_actions, read_writavo_action and run_writavo_action are core tools on both hosts, and listed for the docs page",
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
    "the login default is the 30 agent scopes, sorted, never keys:* or webhooks:*",
    DEFAULT_SCOPES.length === 30 &&
      [...DEFAULT_SCOPES].sort().join() === DEFAULT_SCOPES.join() &&
      !DEFAULT_SCOPES.some((s: string) => /^(keys|webhooks):/.test(s)) &&
      ["site:read", "team:write", "billing:write", "org:write", "logs:read"].every((s) => (DEFAULT_SCOPES as readonly string[]).includes(s)),
    DEFAULT_SCOPES.join(","),
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
    activateKey(SECRET_KEY, "env");
    stub.reset();
    stub.respond = () => ({ status: 200, body: { ok: true, data: { ok: "yes" } } });
    const run = (args: Record<string, unknown>) => handleRunAction(STDIO_CONTEXT, args, FIXTURE_ACTIONS);
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
    const read = (args: Record<string, unknown>) => handleReadAction(STDIO_CONTEXT, args, FIXTURE_ACTIONS);
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
    clearKey();
    stub.reset();
    const noKeyRun = await read({ operation_id: "getBillingSummary" });
    check("run: with no key it says how to sign in and sends nothing", noKeyRun.isError === true && stub.requests.length === 0);
    stub.respond = siteRespond;
  } else {
    check("the fixture catalog was generated", false, "the fixture generator produced no actions");
  }

  // Both hosts register the two tools, and the instructions point at them.
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

  // -- the base URL guard ----------------------------------------------------
  console.log("\n[ The base URL guard ]");
  check("the harness reaches the stub over loopback", CONFIG.apiBaseUrl.startsWith("http://127.0.0.1"));
  const guard = spawn(process.execPath, ["-e", "import('./dist/config.js').then(m => process.stderr.write(m.CONFIG.apiBaseUrl))"], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, WRITAVO_API_BASE_URL: "https://not-writavo.example.com/v1", WRITAVO_API_KEY: SECRET_KEY },
  });
  const guarded = await new Promise<string>((resolve) => {
    let out = "";
    guard.stderr.on("data", (c: Buffer) => {
      out += c.toString();
    });
    guard.on("close", () => resolve(out));
  });
  check(
    "a non-loopback base URL override is ignored",
    guarded.includes("https://api.writavo.com/v1") && !guarded.includes("not-writavo"),
    guarded.slice(0, 200),
  );

  await stub.close();
  await clientProbe();

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
