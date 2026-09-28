/**
 * @writavo/mcp-server/core: the runtime-agnostic tool set, for any host that can speak MCP.
 *
 *   import { createWritavoMcpServer } from "@writavo/mcp-server/core";
 *   const server = createWritavoMcpServer({
 *     apiKey: () => props.apiKey,
 *     userAgent: "writavo-mcp-worker/0.5.0",
 *     host: "remote",
 *   });
 *
 * The hosted server at mcp.writavo.com mounts exactly this, and it is the only Writavo MCP server:
 * the npm stdio package is discontinued (owner ruling 2026-09-28). Nothing in this package reads
 * process.env, touches a filesystem or keeps a key in module state; the smoke test walks the
 * import graph to hold that line.
 */
export { createWritavoMcpServer, toolContext, CORE_LOCAL_TOOL_NAMES } from "./server.js";
export type { CoreOptions } from "./server.js";
export type { ToolContext } from "./context.js";
export { redact } from "./redact.js";
export { friendlyClientName, FALLBACK_CLIENT_NAME } from "./client-name.js";
export { VERSION } from "./version.js";
export { DEFAULT_API_BASE, REMOTE_MCP_URL } from "./constants.js";
export { OPERATIONS, REFUSALS, ACTIONS, ACTION_AREAS } from "../generated/operations.js";
export {
  IMPORT_ID_RE,
  JOB_TTL_DAYS,
  MAX_JOB_BYTES,
  UPLOAD_LINK_MINUTES,
  byteLength,
  fetchImportDocument,
  mergeImportDocuments,
} from "../import/jobs.js";
export type { ImportJobInfo, ImportJobStore, ImportUploadLink } from "../import/jobs.js";
export type { BackgroundRun, BackgroundStatus, PartOutcome, StoredRun, StoredRunResult } from "../import/jobs.js";
export { jobSource } from "../import/jobs.js";
export { runImport, summariseProgress } from "./import-runner.js";
export type { ImportResult, ImportRunStatus, ImportProgressSummary, ImportBudget } from "../import/engine.js";
export { readInlinePart, backgroundStatusText, MAX_INLINE_ARTICLES, MAX_INLINE_BYTES } from "../tools/import-content.js";
