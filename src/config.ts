import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { API_BASE_URL as SPEC_BASE_URL } from "./generated/operations.js";
import { readCredentials, type StoredCredentials } from "./credentials.js";

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
export const DEVICE_URL = `${DASHBOARD_URL}/device`;

// ---------------------------------------------------------------------------
// The active key
// ---------------------------------------------------------------------------
// Read once at start, and then changeable at runtime: `login` activates a key the moment the
// browser approval lands and `logout` drops it, with no restart of the client. Everything that
// needs the key asks apiKey() at the moment it needs it, so there is no copy to go stale.
//
// Precedence is WRITAVO_API_KEY first, then the saved sign-in. An explicit key in the client
// config is a deliberate choice somebody made, and a browser login must not silently override it.

/** Where the key in use came from. */
export type KeySource = "env" | "login" | "none";

/** What is known about a key that came from `login`. Nothing here is secret. */
export interface LoginIdentity {
  websiteId: string;
  websiteName: string;
  keyPrefix: string;
  scopes: string[];
  expiresAt: string | null;
  /** Where the saved sign-in lives, or null when it could not be written. */
  path: string | null;
}

interface ActiveKey {
  key: string;
  source: KeySource;
  identity: LoginIdentity | null;
}

const ENV_KEY = (process.env.WRITAVO_API_KEY ?? "").trim();

/** Why there is no key, when the reason is worth telling someone. */
let inactiveReason: string | null = null;

/** Every secret this process has held, so the redactor can mask one after it stops being active. */
const secretsSeen = new Set<string>();

function identityOf(credentials: StoredCredentials, path: string | null): LoginIdentity {
  return {
    websiteId: credentials.website.id,
    websiteName: credentials.website.name,
    keyPrefix: credentials.key_prefix,
    scopes: credentials.scopes,
    expiresAt: credentials.expires_at,
    path,
  };
}

function initialKey(): ActiveKey {
  if (ENV_KEY) return { key: ENV_KEY, source: "env", identity: null };
  const saved = readCredentials();
  if (saved.state === "valid") {
    return { key: saved.credentials.api_key, source: "login", identity: identityOf(saved.credentials, saved.path) };
  }
  if (saved.state === "expired") {
    rememberSecret(saved.credentials.api_key);
    inactiveReason = `The saved sign-in for ${saved.credentials.website.name} expired on ${saved.credentials.expires_at}. Call login to sign in again.`;
  } else if (saved.state === "invalid") {
    inactiveReason = `The saved sign-in at ${saved.path} was ignored because ${saved.reason}. Call login to replace it.`;
  }
  return { key: "", source: "none", identity: null };
}

let active: ActiveKey = initialKey();
rememberSecret(active.key);

/** The key to send, or "" when there is none. A saved sign-in stops working at its expiry. */
export function apiKey(): string {
  if (active.source === "login" && active.identity?.expiresAt) {
    const at = Date.parse(active.identity.expiresAt);
    if (Number.isFinite(at) && at <= Date.now()) {
      inactiveReason = `The sign-in for ${active.identity.websiteName} expired on ${active.identity.expiresAt}. Call login to sign in again.`;
      active = { key: "", source: "none", identity: null };
    }
  }
  return active.key;
}

export function keySource(): KeySource {
  apiKey();
  return active.source;
}

/** The Site and scopes of a key that came from `login`, or null for an env key or no key. */
export function loginIdentity(): LoginIdentity | null {
  apiKey();
  return active.identity;
}

/** True when WRITAVO_API_KEY is set, which always outranks a saved sign-in. */
export function envKeyPresent(): boolean {
  return ENV_KEY.length > 0;
}

/**
 * Make a key the one in use. `login` calls this on approval; the smoke test calls it to stand in
 * for a configured key. The env key keeps precedence: a login key is refused while one is set.
 */
export function activateKey(key: string, source: Exclude<KeySource, "none">, credentials?: StoredCredentials, path?: string | null): boolean {
  rememberSecret(key);
  if (source === "login" && ENV_KEY) return false;
  active = {
    key,
    source,
    identity: source === "login" && credentials ? identityOf(credentials, path ?? null) : null,
  };
  inactiveReason = null;
  return true;
}

/** Drop the login key, if that is what is in use. An env key is left alone: it is not ours to drop. */
export function deactivateLoginKey(reason?: string): void {
  if (active.source === "login") active = { key: "", source: "none", identity: null };
  if (reason) inactiveReason = reason;
}

/** Test seam as much as anything: clear the key whatever its source. */
export function clearKey(): void {
  active = { key: "", source: "none", identity: null };
  inactiveReason = null;
}

/** Register a secret with the redactor before it is ever active, as `login` does with a pending one. */
export function rememberSecret(secret: string): void {
  if (secret.length >= 8) secretsSeen.add(secret);
}

export type KeyKind = "secret" | "publishable" | "unknown";

export function keyKind(): KeyKind {
  const key = apiKey();
  if (key.startsWith("wv_sk_")) return "secret";
  if (key.startsWith("wv_pub_")) return "publishable";
  return "unknown";
}

export function hasApiKey(): boolean {
  return apiKey().length > 0;
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
  for (const secret of secretsSeen) {
    out = out.split(secret).join("[redacted key]");
  }
  return out;
}

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

/** The no-key reply, led by the reason when there is one worth knowing (an expired sign-in). */
export function noKeyMessage(): string {
  apiKey();
  return inactiveReason ? `${inactiveReason}\n\n${NO_API_KEY_MESSAGE}` : NO_API_KEY_MESSAGE;
}
