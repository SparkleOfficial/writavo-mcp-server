/**
 * @writavo/mcp-server/core: the runtime-agnostic tool set, for any host that can speak MCP.
 *
 *   import { createWritavoMcpServer } from "@writavo/mcp-server/core";
 *   const server = createWritavoMcpServer({
 *     apiKey: () => props.apiKey,
 *     userAgent: "writavo-mcp-worker/0.4.0",
 *     host: "remote",
 *   });
 *
 * The hosted server at mcp.writavo.com mounts exactly this. The npm stdio server mounts it too,
 * through buildWritavoMcpServer with its local extras (browser sign-in, files on disk). Nothing
 * reachable from this entry reads process.env, touches a filesystem or keeps a key in module state;
 * the smoke test walks the import graph to hold that line.
 */
export { createWritavoMcpServer, buildWritavoMcpServer, toolContext, CORE_LOCAL_TOOL_NAMES } from "./server.js";
export type { CoreOptions, HostExtras } from "./server.js";
export type { ToolContext } from "./context.js";
export { redact } from "./redact.js";
export { friendlyClientName, FALLBACK_CLIENT_NAME } from "./client-name.js";
export { VERSION } from "./version.js";
export { DEFAULT_API_BASE, REMOTE_MCP_URL } from "./constants.js";
export { OPERATIONS, REFUSALS, ACTIONS, ACTION_AREAS } from "../generated/operations.js";
