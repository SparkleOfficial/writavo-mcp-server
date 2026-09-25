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

Or configure a key by hand:

1. Sign up or sign in at ${SIGNUP_URL}
2. Create a secret key at ${KEYS_URL} and give it the scopes you want the assistant to have
3. Put the key in your MCP client config and restart the client:

   {
     "mcpServers": {
       "writavo": {
         "command": "npx",
         "args": ["-y", "@writavo/mcp-server"],
         "env": { "WRITAVO_API_KEY": "wv_sk_your_key_here" }
       }
     }
   }

A secret key (wv_sk_) can read and write content. A publishable key (wv_pub_) can only read
published content, so it cannot create or publish anything.

The get_api_docs tool works without a key, so you can read the whole API reference first.`;

/** The hosted server's version: there is no config file to edit and no login tool to call. */
export const NOT_SIGNED_IN_REMOTE = `This connection to Writavo carries no credentials, so this tool cannot reach your Site.

Reconnect Writavo in your AI assistant's connector or MCP settings (the server is
${REMOTE_MCP_URL}). It signs you in through the browser, where you choose the Site and what the
assistant may do. Someone without an account can create one on the same page.

If the connection was working before, the key behind it may have been revoked or turned off:
check ${AGENTS_URL}. Setup instructions for every client are at ${MCP_DOCS_URL}.

The get_api_docs tool works without signing in, so you can read the whole API reference first.`;
