import { AGENTS_URL, MCP_DOCS_URL, REMOTE_MCP_URL } from "./constants.js";

/**
 * The reply a key-requiring tool gives when the connection carries no key. Text only: the host
 * may append its own hint (CoreOptions.notSignedInHint).
 */
export const NOT_SIGNED_IN_REMOTE = `This connection to Writavo carries no credentials, so this tool cannot reach your Site.

Reconnect Writavo in your AI assistant's connector or MCP settings (the server is
${REMOTE_MCP_URL}). It signs you in through the browser, where you choose the Site and what the
assistant may do. Someone without an account can create one on the same page.

If the connection was working before, the key behind it may have been revoked or turned off:
check ${AGENTS_URL}. Setup instructions for every client are at ${MCP_DOCS_URL}.

The get_api_docs tool works without signing in, so you can read the whole API reference first.`;
