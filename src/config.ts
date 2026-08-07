import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL as SPEC_BASE_URL } from "./generated/operations.js";

/**
 * Server version, read from package.json at runtime so it can never drift from what npm
 * published. package.json sits one level up from this file in the source tree (src/), in the
 * compiled output (dist/) and inside the installed package, so "../package.json" resolves in
 * every case.
 */
function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return String(JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/**
 * The base URL is the one in openapi.yaml and nowhere else.
 *
 * NON-NEGOTIABLE 1: the key never leaves this machine except as a bearer header to the Writavo
 * API. An environment variable that could repoint the base URL at any host would be a one line
 * key exfiltration route for anything that can write a config file, so the override is honoured
 * ONLY for a loopback address, which is what the test harness in scripts/ uses. Anything else is
 * ignored, loudly, on stderr.
 */
function resolveBaseUrl(): { url: string; overridden: boolean; rejected: string | null } {
  const raw = process.env.WRITAVO_API_BASE_URL;
  if (!raw) return { url: SPEC_BASE_URL, overridden: false, rejected: null };
  try {
    const parsed = new URL(raw);
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (loopback && parsed.protocol === "http:") {
      return { url: raw.replace(/\/$/, ""), overridden: true, rejected: null };
    }
    return { url: SPEC_BASE_URL, overridden: false, rejected: raw };
  } catch {
    return { url: SPEC_BASE_URL, overridden: false, rejected: raw };
  }
}

const base = resolveBaseUrl();

export const VERSION = readVersion();

export const CONFIG = {
  apiBaseUrl: base.url,
  apiKey: process.env.WRITAVO_API_KEY ?? "",
  /** True only when the base URL points at loopback, which is the test harness. */
  baseUrlOverridden: base.overridden,
  rejectedBaseUrl: base.rejected,
  /** One retry, honouring Retry-After, capped so a tool call cannot hang a client for minutes. */
  maxRetryWaitMs: 30_000,
  requestTimeoutMs: 60_000,
};

export const DASHBOARD_URL = "https://app.writavo.com";
export const DOCS_URL = "https://writavo.com/docs";
export const KEYS_URL = `${DASHBOARD_URL}/settings/api-keys`;
export const BILLING_URL = `${DASHBOARD_URL}/billing`;
export const SIGNUP_URL = `${DASHBOARD_URL}/signup`;

export type KeyKind = "secret" | "publishable" | "unknown";

export function keyKind(): KeyKind {
  if (CONFIG.apiKey.startsWith("wv_sk_")) return "secret";
  if (CONFIG.apiKey.startsWith("wv_pub_")) return "publishable";
  return "unknown";
}

export function hasApiKey(): boolean {
  return CONFIG.apiKey.length > 0;
}

/**
 * NON-NEGOTIABLE 2: a raw key must never reach stdout, stderr or an error message. Every string
 * this server emits passes through here, so a key that ends up somewhere by accident, in a URL an
 * API echoed back or in a stack trace, is masked on the way out rather than relied upon never to
 * arrive.
 */
export function redact(text: string): string {
  // The negative lookahead is the same placeholder convention scripts/check-docs-drift.mjs uses
  // to tell a documented example from a real credential. Without it the instructions for someone
  // who has no key would have their own placeholder masked out.
  let out = text.replace(
    /wv_(sk|pub)_(?!your_|YOUR_|EXAMPLE|REDACTED)[A-Za-z0-9_-]{8,}/g,
    (_m, kind: string) => `wv_${kind}_REDACTED`,
  );
  if (CONFIG.apiKey.length >= 8) {
    out = out.split(CONFIG.apiKey).join("[redacted key]");
  }
  return out;
}

export const NO_API_KEY_MESSAGE = `No Writavo API key is configured, so this tool cannot reach your Site.

To fix it:

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
