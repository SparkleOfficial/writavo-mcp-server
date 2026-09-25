#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { CONFIG, redact } from "./config.js";
import { startKeyExtension } from "./stdio/key-lifecycle.js";

/**
 * NON-NEGOTIABLE 2. On a stdio MCP server, stdout IS the protocol channel: one stray line written
 * there is a parse error at the client and a dropped connection, and if that line happened to
 * carry a key it is now in the client's logs too.
 *
 * So stdout is closed to everything except the transport. Every console channel is rebound to
 * stderr, and every line through it is redacted on the way out. This runs before the server is
 * built, so a dependency that logs at import time is caught as well.
 */
function sealStdout(): void {
  const toStderr =
    (prefix: string) =>
    (...args: unknown[]): void => {
      const line = args
        .map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeJson(a)))
        .join(" ");
      process.stderr.write(`${prefix}${redact(line)}\n`);
    };

  console.log = toStderr("");
  console.info = toStderr("");
  console.debug = toStderr("");
  console.warn = toStderr("warning: ");
  console.error = toStderr("");
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function main(): Promise<void> {
  sealStdout();

  if (CONFIG.rejectedBaseUrl) {
    console.warn(
      `WRITAVO_API_BASE_URL was ignored. The API key is only ever sent to ${CONFIG.apiBaseUrl}, so an override is honoured for a local loopback address and nothing else.`,
    );
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // A browser sign-in's key is extended while it is in use, checked now and then daily. After
  // connect, so a slow or unreachable API can never delay the handshake.
  startKeyExtension((line) => console.error(line));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${redact(`The Writavo MCP server failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)}\n`,
  );
  process.exit(1);
});
