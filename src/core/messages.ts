import { AGENTS_URL, KEYS_URL, MCP_DOCS_URL, REMOTE_MCP_URL, SIGNUP_URL } from "./constants.js";

/**
 * The replies a key-requiring tool gives when there is no key, one per host. Text only: whether a
 * key exists is the host's business, and the stdio host leads this with the reason when it has one
 * (an expired saved sign-in).
 */

export const NO_API_KEY_MESSAGE = `No Writavo API key is configured, so this tool cannot reach your Site.

The quickest fix is to call the login tool. It returns a link for the user to open in their
browser, where they sign in (or create an account), pick a Site and approve. This server then
starts using the new key by itself: no key to copy and no restart.

Or connect to the hosted Writavo MCP server, ${REMOTE_MCP_URL}, which is the supported way to use
Writavo over MCP. There is nothing to install: add the URL to your MCP client and sign in through
the browser.

   {
     "mcpServers": {
       "writavo": { "type": "http", "url": "${REMOTE_MCP_URL}" }
     }
   }

The exact command or config for every client is at ${MCP_DOCS_URL}. A client that cannot sign in
through the browser can send a secret key (wv_sk_, created at ${KEYS_URL}) as an
"Authorization: Bearer" header instead. Sign up or sign in at ${SIGNUP_URL}.

The get_api_docs tool works without a key, so you can read the whole API reference first.`;

/** The hosted server's version: there is no config file to edit and no login tool to call. */
export const NOT_SIGNED_IN_REMOTE = `This connection to Writavo carries no credentials, so this tool cannot reach your Site.

Reconnect Writavo in your AI assistant's connector or MCP settings (the server is
${REMOTE_MCP_URL}). It signs you in through the browser, where you choose the Site and what the
assistant may do. Someone without an account can create one on the same page.

If the connection was working before, the key behind it may have been revoked or turned off:
check ${AGENTS_URL}. Setup instructions for every client are at ${MCP_DOCS_URL}.

The get_api_docs tool works without signing in, so you can read the whole API reference first.`;
