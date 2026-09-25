import { apiRequest, WritavoApiError } from "../api/client.js";
import { keySource, updateLoginExpiry } from "../config.js";
import { readCredentials, writeCredentials, type StoredCredentials } from "../credentials.js";
import { contextForKey } from "./context.js";

/**
 * The saved sign-in's key, looked after over its life (MCP-2 item 8).
 *
 * A browser sign-in makes a 90 day key. Left alone it dies mid-project and the person has to sign
 * in again for no reason, so while it is in use this server asks the API to extend it once it is
 * within 30 days of expiry. The API decides: it extends only keys an agent signed in with, only
 * while their creator still holds the permission to manage keys, and never past a year from
 * creation. And on logout the key is revoked on Writavo, not just forgotten on this machine.
 *
 * Neither call is a tool. The routes are withheld from the generated surface for exactly that
 * reason (scripts/gen-mcp-tools.mjs, HOST_OWNED_PREFIX): a model has no business keeping its own
 * credential alive or revoking it.
 */

const DAY_MS = 86_400_000;
/** Ask when the key has fewer than this many days left. Mirrors the API's own threshold. */
const EXTEND_WITHIN_MS = 30 * DAY_MS;
/** Ask at most this often, however often the client restarts the server. */
const CHECK_EVERY_MS = DAY_MS;

export type ExtendOutcome =
  | { state: "skipped"; reason: string }
  | { state: "extended"; expiresAt: string }
  | { state: "unchanged"; expiresAt: string | null; reason: string | null }
  | { state: "refused"; reason: string }
  | { state: "failed"; reason: string };

interface ExtendResponse {
  key?: { id?: string; expires_at?: string | null };
  extended?: boolean;
  reason?: string;
}

function recordCheck(credentials: StoredCredentials, now: number, expiresAt?: string | null): void {
  try {
    writeCredentials({
      ...credentials,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
      extend_checked_at: new Date(now).toISOString(),
    });
  } catch {
    // A read-only config directory costs a daily re-check, nothing more.
  }
}

/** Extend the saved sign-in's key when it is due. Never throws. */
export async function extendSavedKeyIfDue(now = Date.now()): Promise<ExtendOutcome> {
  if (keySource() !== "login") return { state: "skipped", reason: "the saved sign-in is not the key in use" };
  const saved = readCredentials();
  if (saved.state !== "valid") return { state: "skipped", reason: `the saved sign-in is ${saved.state}` };
  const credentials = saved.credentials;
  if (!credentials.api_key.startsWith("wv_sk_")) return { state: "skipped", reason: "not a secret key" };

  const expiresAt = credentials.expires_at ? Date.parse(credentials.expires_at) : Number.NaN;
  if (!Number.isFinite(expiresAt)) return { state: "skipped", reason: "the key has no recorded expiry" };
  if (expiresAt - now > EXTEND_WITHIN_MS) return { state: "skipped", reason: "more than 30 days left" };

  const checked = credentials.extend_checked_at ? Date.parse(credentials.extend_checked_at) : Number.NaN;
  if (Number.isFinite(checked) && now - checked < CHECK_EVERY_MS) {
    return { state: "skipped", reason: "already asked in the last day" };
  }

  let data: ExtendResponse;
  try {
    const response = await apiRequest<ExtendResponse>(contextForKey(credentials.api_key), {
      method: "POST",
      path: "/auth/key/extend",
      body: {},
    });
    data = response.data ?? {};
  } catch (err) {
    if (err instanceof WritavoApiError && err.status > 0 && err.status < 500 && err.status !== 429) {
      // A refusal is an answer (not extendable, creator lacks the permission, agent access off, or
      // an API that predates the route). Remember it was asked, so it is not asked again today.
      recordCheck(credentials, now);
      return { state: "refused", reason: `${err.code}: ${err.message}` };
    }
    return { state: "failed", reason: err instanceof Error ? err.message : String(err) };
  }

  const newExpiry = typeof data.key?.expires_at === "string" ? data.key.expires_at : null;
  if (data.extended === true && newExpiry) {
    recordCheck(credentials, now, newExpiry);
    updateLoginExpiry(newExpiry);
    return { state: "extended", expiresAt: newExpiry };
  }
  recordCheck(credentials, now);
  return { state: "unchanged", expiresAt: newExpiry ?? credentials.expires_at, reason: data.reason ?? null };
}

/**
 * On start, and then once a day for as long as the process lives. The timer never keeps the
 * process alive after the client has gone.
 */
export function startKeyExtension(log: (line: string) => void): void {
  const run = (): void => {
    void extendSavedKeyIfDue().then((outcome) => {
      if (outcome.state === "extended") log(`Extended the saved Writavo sign-in; the key now expires on ${outcome.expiresAt}.`);
      else if (outcome.state === "refused") log(`The saved Writavo sign-in could not be extended (${outcome.reason}).`);
    });
  };
  run();
  const timer = setInterval(run, CHECK_EVERY_MS);
  timer.unref();
}

export type RevokeOutcome = { state: "revoked" } | { state: "already_invalid"; reason: string } | { state: "failed"; reason: string };

/** Revoke a key on Writavo, using the key itself. Never throws. */
export async function revokeKey(key: string): Promise<RevokeOutcome> {
  try {
    await apiRequest(contextForKey(key, "logout"), { method: "POST", path: "/auth/key/revoke", body: {} });
    return { state: "revoked" };
  } catch (err) {
    if (err instanceof WritavoApiError && (err.code === "INVALID_API_KEY" || err.code === "API_KEY_REVOKED" || err.code === "API_KEY_EXPIRED")) {
      return { state: "already_invalid", reason: err.code };
    }
    return { state: "failed", reason: err instanceof WritavoApiError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err) };
  }
}
