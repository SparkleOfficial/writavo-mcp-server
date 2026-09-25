import { API_BASE_URL as SPEC_BASE_URL } from "./generated/operations.js";
import { readCredentials, type StoredCredentials } from "./credentials.js";
import { MAX_RETRY_WAIT_MS, REQUEST_TIMEOUT_MS } from "./core/constants.js";
import { rememberSecret } from "./core/redact.js";
import { NO_API_KEY_MESSAGE } from "./core/messages.js";
import { VERSION } from "./core/version.js";

/**
 * THE STDIO HOST'S CONFIGURATION. This module reads the environment and the saved sign-in, so it
 * belongs to the npm server alone; nothing under src/core imports it. The hosted server gets the
 * same values from CoreOptions instead.
 */

export { VERSION };
export { redact, rememberSecret } from "./core/redact.js";
export { NO_API_KEY_MESSAGE } from "./core/messages.js";
export {
  BILLING_URL,
  DASHBOARD_URL,
  DEVICE_URL,
  DOCS_URL,
  KEYS_URL,
  SIGNUP_URL,
} from "./core/constants.js";

/** What this server calls itself on every request. */
export const USER_AGENT = `writavo-mcp-server/${VERSION}`;

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

export const CONFIG = {
  apiBaseUrl: base.url,
  /** True only when the base URL points at loopback, which is the test harness. */
  baseUrlOverridden: base.overridden,
  rejectedBaseUrl: base.rejected,
  maxRetryWaitMs: MAX_RETRY_WAIT_MS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
};

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

/**
 * Keep a saved sign-in's identity in step after its expiry moved (the key was extended). Only the
 * login key's identity changes; the key itself does not.
 */
export function updateLoginExpiry(expiresAt: string | null): void {
  if (active.source === "login" && active.identity) active.identity = { ...active.identity, expiresAt };
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

/** The no-key reply, led by the reason when there is one worth knowing (an expired sign-in). */
export function noKeyMessage(): string {
  apiKey();
  return inactiveReason ? `${inactiveReason}\n\n${NO_API_KEY_MESSAGE}` : NO_API_KEY_MESSAGE;
}
