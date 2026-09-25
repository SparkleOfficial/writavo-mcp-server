import { API_BASE_URL } from "../generated/operations.js";

/**
 * Fixed addresses the replies point people at. Constants, never configuration: a link a person is
 * asked to open and sign in at is not something an environment variable should be able to move.
 */
export const DASHBOARD_URL = "https://app.writavo.com";
export const DOCS_URL = "https://writavo.com/docs";
export const MCP_DOCS_URL = `${DOCS_URL}/mcp`;
export const KEYS_URL = `${DASHBOARD_URL}/settings/api-keys`;
export const AGENTS_URL = `${DASHBOARD_URL}/settings/agents`;
export const BILLING_URL = `${DASHBOARD_URL}/billing`;
export const SIGNUP_URL = `${DASHBOARD_URL}/signup`;
export const DEVICE_URL = `${DASHBOARD_URL}/device`;

/** The hosted server. */
export const REMOTE_MCP_URL = "https://mcp.writavo.com/mcp";

/** The base URL in openapi.yaml, which is where a key is sent unless a host says otherwise. */
export const DEFAULT_API_BASE = API_BASE_URL;

/** One retry, honouring Retry-After, capped so a tool call cannot hang a client for minutes. */
export const MAX_RETRY_WAIT_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 60_000;
