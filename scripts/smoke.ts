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
 *
 * The live round trip is scripts/integration.ts, which needs a real key and a deployed API.
 *
 *   pnpm --filter @writavo/mcp-server smoke
 */

import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
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
    check(
      `the tool list loads: ${tools.length} tools`,
      tools.length === OPERATIONS.length + 2,
      `expected ${OPERATIONS.length + 2} (${OPERATIONS.length} generated plus upload_media and get_api_docs), got ${tools.length}`,
    );
    check(
      "every tool carries a description and an input schema",
      tools.every((t) => t.description && t.description.length > 40 && t.inputSchema),
      tools.filter((t) => !t.description || t.description.length <= 40).map((t) => t.name).join(", "),
    );

    send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
    const resources = ((await waitFor(3)).result?.resources ?? []) as { uri: string }[];
    check("the three resources are listed", resources.length === 3, resources.map((r) => r.uri).join(", "));

    send({ jsonrpc: "2.0", id: 4, method: "prompts/list" });
    const prompts = ((await waitFor(4)).result?.prompts ?? []) as { name: string }[];
    check(
      "both prompts are listed",
      prompts.length === 2 && prompts.some((p) => p.name === "draft-article") && prompts.some((p) => p.name === "publish-checklist"),
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

    // Everything above ran on one connection. If a stray write had corrupted the stream the
    // requests after it would never have been answered.
    check("nothing extraneous was written to stdout", badLines.length === 0, badLines.slice(0, 3).join(" | "));
    check(
      "every stdout frame is a JSON-RPC message",
      frames.every((f) => f.jsonrpc === "2.0"),
      JSON.stringify(frames.filter((f) => f.jsonrpc !== "2.0")).slice(0, 200),
    );
    check("the client is still connected after six exchanges", child.exitCode === null);
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

  const { CONFIG, redact, NO_API_KEY_MESSAGE } = await import("../src/config.js");
  const { OPERATIONS, REFUSALS } = await import("../src/generated/operations.js");
  const { ERROR_CATALOG } = await import("../src/generated/errors.js");
  const { REFERENCE_SECTIONS } = await import("../src/generated/reference.js");
  const { callOperation } = await import("../src/tools/call.js");
  const { handleGetApiDocs } = await import("../src/tools/api-docs.js");
  const { handleUploadMedia } = await import("../src/tools/upload-media.js");
  const { inputShapeFor } = await import("../src/tools/schema.js");

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
  ];
  const withDash = userVisible.filter((s) => /[—–]/.test(s));
  check(`10. no em-dash or en-dash in ${userVisible.length} user-visible strings`, withDash.length === 0, withDash[0]?.slice(0, 120) ?? "");

  // -- 4. the no-key experience ---------------------------------------------
  console.log("\n[ 4. The no-key experience ]");
  CONFIG.apiKey = "";
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
  CONFIG.apiKey = PUBLISHABLE_KEY;
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
  CONFIG.apiKey = SECRET_KEY;
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
