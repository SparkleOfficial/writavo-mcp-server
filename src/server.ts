import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildWritavoMcpServer, CORE_LOCAL_TOOL_NAMES } from "./core/server.js";
import { noKeyMessage } from "./config.js";
import { LOGIN, LOGIN_STATUS, LOGOUT, handleLogin, handleLoginStatus, handleLogout } from "./tools/login.js";
import { setClientInfoSource } from "./auth/device.js";
import type { ToolArgs } from "./tools/call.js";
import { IMPORT_FILES, MEDIA_FILES } from "./stdio/files.js";
import { stdioOptions } from "./stdio/context.js";

/**
 * THE STDIO HOST. The core (src/core) is the whole tool set, shared with the hosted server at
 * mcp.writavo.com; this adds what only a process on the user's own machine can do:
 *
 *   - login, login_status and logout: a browser sign-in whose key is generated and kept here;
 *   - `path` on import_content (a file of any size, imported in batches, with a progress file)
 *     and on upload_media (a local image).
 */

/** The tools only this host adds. */
export const STDIO_TOOL_NAMES = [LOGIN.name, LOGIN_STATUS.name, LOGOUT.name] as const;

/**
 * The tools written by hand rather than generated from a row of openapi.yaml. Exported so the
 * smoke test can count the surface without a second list to keep in step. Every name here must
 * also be in LOCAL_TOOLS in scripts/mcp-surface.mjs, which is what the docs page lists.
 */
export const LOCAL_TOOL_NAMES = [...CORE_LOCAL_TOOL_NAMES, ...STDIO_TOOL_NAMES] as const;

export function createServer(): McpServer {
  return buildWritavoMcpServer(stdioOptions(), {
    notSignedIn: noKeyMessage,
    importFiles: IMPORT_FILES,
    mediaFiles: MEDIA_FILES,
    registerTools: (server) => {
      // The key login makes is named after the connected client (Addendum B), which the client
      // states in the initialize handshake. Read at sign-in time, so it is always the live one.
      setClientInfoSource(() => server.server.getClientVersion()?.name);

      // Hand-written: each is a local flow (a background poll, a file on disk) rather than a
      // request, and the key they manage never leaves this machine except as a bearer header.
      server.registerTool(
        LOGIN.name,
        {
          title: "Sign in through the browser",
          description: LOGIN.description,
          inputSchema: LOGIN.inputSchema,
          annotations: { title: "Sign in through the browser", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        async (args: unknown) => handleLogin((args ?? {}) as ToolArgs),
      );

      server.registerTool(
        LOGIN_STATUS.name,
        {
          title: "Check sign-in",
          description: LOGIN_STATUS.description,
          inputSchema: LOGIN_STATUS.inputSchema,
          annotations: { title: "Check sign-in", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        async () => handleLoginStatus(),
      );

      server.registerTool(
        LOGOUT.name,
        {
          title: "Sign out",
          description: LOGOUT.description,
          inputSchema: LOGOUT.inputSchema,
          // It revokes the key on Writavo, which cannot be undone; signing in again makes a new one.
          annotations: { title: "Sign out", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        async () => handleLogout(),
      );
    },
  });
}
