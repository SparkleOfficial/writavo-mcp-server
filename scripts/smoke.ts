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
 *
 * The live round trip is scripts/integration.ts, which needs a real key and a deployed API.
 *
 *   pnpm --filter @writavo/mcp-server smoke
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";

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

    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const listed = await waitFor(2);
    const tools = (listed.result?.tools ?? []) as { name: string; description: string; inputSchema: unknown }[];
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
  const { handleGetApiDocs } = await import("../src/tools/api-docs.js");
  const { handleUploadMedia } = await import("../src/tools/upload-media.js");
  const { inputShapeFor } = await import("../src/tools/schema.js");
  const { keySource, hasApiKey } = await import("../src/config.js");
  const { LOGIN, LOGIN_STATUS, LOGOUT, handleLogin, handleLoginStatus, handleLogout } = await import("../src/tools/login.js");
  const { START_PLAN_PURCHASE, handleStartPlanPurchase } = await import("../src/tools/plan-purchase.js");
  const { IMPORT_CONTENT, handleImportContent } = await import("../src/tools/import-content.js");
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
    ...[LOGIN, LOGIN_STATUS, LOGOUT, START_PLAN_PURCHASE, IMPORT_CONTENT].map((t) => t.description),
    IMPORT_FORMAT_GUIDE,
    migrateContentPrompt({}).messages[0]!.content.text,
  ];
  const withDash = userVisible.filter((s) => /[—–]/.test(s));
  check(`10. no em-dash or en-dash in ${userVisible.length} user-visible strings`, withDash.length === 0, withDash[0]?.slice(0, 120) ?? "");

  // -- 4. the no-key experience ---------------------------------------------
  console.log("\n[ 4. The no-key experience ]");
  clearKey();
  stub.reset();
  const noKey = await callOperation(operation("list_articles"), {});
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
    (await handleUploadMedia({ file_path: "/tmp/x.png" })).isError === true,
  );

  // -- 5. the scope probe ----------------------------------------------------
  console.log("\n[ 5. The scope probe ]");
  activateKey(PUBLISHABLE_KEY, "env");
  stub.reset();
  const scoped = await callOperation(operation("publish_article"), { id: "00000000-0000-4000-8000-000000000000", confirm: true });
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
  const apiScope = await callOperation(operation("list_media"), {});
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
  const credits = await callOperation(operation("trigger_pipeline_run"), { confirm: true });
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
  const entitlement = await callOperation(operation("trigger_pipeline_run"), { confirm: true });
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
    const unconfirmed = await callOperation(op, { id: "00000000-0000-4000-8000-000000000000", scheduled_publish_at: "2030-01-01T00:00:00Z" });
    const body = bodyOf(unconfirmed);
    check(
      `${tool} does nothing without confirm: true`,
      stub.requests.length === 0 && body.startsWith("Nothing has been done.") && body.includes("confirm: true"),
      `${stub.requests.length} request(s) reached the API. ${body.slice(0, 160)}`,
    );
  }
  stub.reset();
  const confirmed = await callOperation(operation("publish_article"), { id: "00000000-0000-4000-8000-000000000000", confirm: true });
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
  transcript.push(bodyOf(await callOperation(operation("list_articles"), {})));
  transcript.push(bodyOf(await callOperation(operation("get_article"), { id: "00000000-0000-4000-8000-000000000000" })));
  stub.respond = () => ({ status: 200, body: { ok: true, data: { echo: SECRET_KEY } } });
  transcript.push(bodyOf(await callOperation(operation("get_usage"), {})));
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
  check("it names the client", startBody.client_name === "Writavo MCP server");
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
  leakTranscript.push(bodyOf(await callOperation(operation("get_site_info"), {})));
  check("the next tool call sends the new key", stub.requests[0]?.authorization === `Bearer ${String(savedLogin.api_key)}`);

  stub.reset();
  const again = bodyOf(await handleLogin({}));
  leakTranscript.push(again);
  check(
    "a second login says it is already signed in, names the Site, and starts nothing",
    again.includes("Already signed in") && again.includes("Smoke Site") && again.includes("force: true") && stub.requests.length === 0,
    again.slice(0, 200),
  );

  const loggedOut = bodyOf(handleLogout());
  leakTranscript.push(loggedOut);
  check("logout deletes the saved sign-in", !existsSync(credentialsPath()));
  check("logout stops using the key", !hasApiKey() && keySource() === "none");
  check(
    "logout says the key lives on until revoked, and where",
    loggedOut.includes("app.writavo.com/settings/api-keys") && /revoke/i.test(loggedOut),
    loggedOut.slice(0, 300),
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

  // -- 13. the plan purchase link --------------------------------------------
  console.log("\n[ 13. The plan purchase link ]");
  clearKey();
  stub.reset();
  const planNoKey = bodyOf(await handleStartPlanPurchase({ plan: "growth", interval: "year" }));
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
  const planWithKey = bodyOf(await handleStartPlanPurchase({}));
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
  const invalid = bodyOf(await handleImportContent({ file_path: badPath }));
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
  const dry = bodyOf(await handleImportContent({ file_path: fixturePath }));
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
  const unconfirmed = bodyOf(await handleImportContent({ file_path: fixturePath, dry_run: false }));
  importTranscript.push(unconfirmed);
  check(
    "an import that publishes does nothing without confirm: true",
    unconfirmed.startsWith("Nothing has been done.") && writes().length === 0,
    unconfirmed.slice(0, 200),
  );

  stub.reset();
  const applied = bodyOf(await handleImportContent({ file_path: fixturePath, dry_run: false, confirm: true }));
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
  const rerun = bodyOf(await handleImportContent({ file_path: fixturePath, dry_run: false, confirm: true }));
  importTranscript.push(rerun);
  check(
    "running it again is a no-op",
    rerun.includes("Import complete") && writes().length === 0 && site.articles.length === 3,
    `${writes().length} writes: ${writes().map((r) => `${r.method} ${r.path}`).join(", ")}`,
  );

  fixture.articles[1] = { ...fixture.articles[1]!, title: "Winter notes, revised" };
  writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  stub.reset();
  const updated = bodyOf(await handleImportContent({ file_path: fixturePath, dry_run: false, confirm: true }));
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
  globalThis.fetch = realFetch;

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
