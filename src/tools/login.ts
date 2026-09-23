import { z } from "zod";
import { WritavoApiError } from "../api/client.js";
import {
  CLIENT_NAME,
  DEFAULT_SCOPES,
  clientHost,
  generateDeviceSecret,
  pollDeviceToken,
  startDeviceAuthorization,
  verificationLink,
  type DeviceSecret,
  type DeviceToken,
} from "../auth/device.js";
import {
  KEYS_URL,
  SIGNUP_URL,
  activateKey,
  deactivateLoginKey,
  envKeyPresent,
  keySource,
  loginIdentity,
} from "../config.js";
import { deleteCredentials, writeCredentials, type StoredCredentials } from "../credentials.js";
import { formatApiError, text, toolError, type ToolResult } from "../errors.js";
import type { ToolArgs } from "./call.js";

/**
 * Sign in from the assistant, without anyone pasting a key.
 *
 * `login` starts a browser approval and returns at once with a link for the person; a poll in
 * the background picks up the approval, saves the key and puts it into use, so the very next tool
 * call works. `login_status` is how the model finds out. Nothing blocks a tool call for the
 * minutes a person may spend signing up, confirming an email and finishing onboarding.
 */

export const LOGIN = {
  name: "login",
  description:
    "Sign this assistant in to a Writavo Site through the browser, so nobody has to create or paste an API key. Returns a link and a short code to show the user; they open the link, sign in or create an account, choose the Site and approve. The approval is picked up in the background and the new key is used by every tool from then on, with no restart. Call login_status every few seconds to see when it lands. If a sign-in is already active it says so and changes nothing; pass force: true to replace it, for example to switch Site. Needs no API key.",
  inputSchema: {
    scopes: z
      .array(z.enum(DEFAULT_SCOPES))
      .min(1)
      .optional()
      .describe(
        `What the new key may do. Defaults to all of: ${DEFAULT_SCOPES.join(", ")}. Credential and webhook management are never available here.`,
      ),
    force: z
      .boolean()
      .optional()
      .describe("Replace an existing sign-in or a pending request. Only after the user has said they want to switch."),
  },
};

export const LOGIN_STATUS = {
  name: "login_status",
  description:
    "Report where sign-in stands: not started, waiting for the user to approve in the browser (with the link and code again), approved (the Site, key prefix, scopes and expiry), denied or expired. Call it every few seconds while the user is approving. Needs no API key and makes no request.",
  inputSchema: {},
};

export const LOGOUT = {
  name: "logout",
  description:
    "Sign this assistant out: delete the saved sign-in from this machine and stop using its key. The key itself keeps working until it is revoked in the dashboard or expires, and the reply says where to revoke it. Does not touch a key set with WRITAVO_API_KEY in the client config.",
  inputSchema: {},
};

// ---------------------------------------------------------------------------
// The one sign-in this process can have in flight
// ---------------------------------------------------------------------------
type LoginState =
  | { phase: "idle" }
  | {
      phase: "pending";
      userCode: string;
      link: string;
      deviceCode: string;
      expiresAt: number;
      intervalMs: number;
      secret: DeviceSecret;
      scopes: string[];
      note: string | null;
    }
  | {
      phase: "approved";
      websiteName: string;
      keyPrefix: string;
      scopes: string[];
      expiresAt: string | null;
      savedTo: string | null;
      saveError: string | null;
      shadowedByEnv: boolean;
    }
  | { phase: "denied" }
  | { phase: "expired" }
  | { phase: "failed"; message: string };

let state: LoginState = { phase: "idle" };
/** Bumped whenever the pending request is replaced or abandoned, so a stale poll does nothing. */
let generation = 0;
let timer: NodeJS.Timeout | null = null;

const sleepThen = (ms: number, run: () => void): void => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, ms);
  // A pending sign-in must never be the reason the process stays alive after the client leaves.
  timer.unref();
};

function cancelPending(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule(gen: number, ms: number): void {
  sleepThen(ms, () => {
    void pollOnce(gen);
  });
}

async function pollOnce(gen: number): Promise<void> {
  if (gen !== generation || state.phase !== "pending") return;
  const pending = state;
  if (Date.now() >= pending.expiresAt) {
    state = { phase: "expired" };
    return;
  }

  let result: DeviceToken;
  try {
    result = await pollDeviceToken(pending.deviceCode);
  } catch (err) {
    if (gen !== generation) return;
    if (err instanceof WritavoApiError && err.code === "NOT_FOUND") {
      state = { phase: "failed", message: "Writavo no longer recognises this sign-in request. Call login to start again." };
      return;
    }
    // A dropped connection or a busy server is not an answer. Keep asking, more slowly.
    pending.note = `The last check could not reach Writavo (${err instanceof Error ? err.message : String(err)}). Still retrying.`;
    schedule(gen, Math.min(pending.intervalMs * 2, 30_000));
    return;
  }
  if (gen !== generation) return;
  pending.note = null;

  switch (result.status) {
    case "pending":
      schedule(gen, pending.intervalMs);
      return;
    case "slow_down":
      // RFC 8628: add five seconds, or take the server's figure if that is longer.
      pending.intervalMs = Math.max(pending.intervalMs + 5_000, (result.interval ?? 0) * 1000);
      schedule(gen, pending.intervalMs);
      return;
    case "denied":
      state = { phase: "denied" };
      return;
    case "expired":
      state = { phase: "expired" };
      return;
    case "approved":
      complete(pending.secret, result);
      return;
    default:
      schedule(gen, pending.intervalMs);
  }
}

function complete(secret: DeviceSecret, approved: Extract<DeviceToken, { status: "approved" }>): void {
  // The approved key must be the one generated here. If the prefixes disagree the approval was for
  // some other request, and saving our secret against it would store a key that does not work.
  if (approved.key.key_prefix && approved.key.key_prefix !== secret.prefix) {
    state = {
      phase: "failed",
      message: "The approval that came back is for a different key than the one this server generated, so nothing was saved. Call login to start again.",
    };
    return;
  }

  const credentials: StoredCredentials = {
    version: 1,
    api_key: secret.secret,
    key_id: approved.key.id,
    key_prefix: secret.prefix,
    website: { id: approved.website.id, name: approved.website.name },
    scopes: approved.key.scopes ?? [],
    expires_at: approved.key.expires_at ?? null,
    created_at: new Date().toISOString(),
  };

  let savedTo: string | null = null;
  let saveError: string | null = null;
  try {
    savedTo = writeCredentials(credentials);
  } catch (err) {
    saveError = err instanceof Error ? err.message : String(err);
  }

  const activated = activateKey(secret.secret, "login", credentials, savedTo);
  state = {
    phase: "approved",
    websiteName: credentials.website.name,
    keyPrefix: credentials.key_prefix,
    scopes: credentials.scopes,
    expiresAt: credentials.expires_at,
    savedTo,
    saveError,
    shadowedByEnv: !activated,
  };
}

// ---------------------------------------------------------------------------
// Replies
// ---------------------------------------------------------------------------
function pendingInstructions(pending: Extract<LoginState, { phase: "pending" }>, lead: string): string {
  const minutes = Math.max(1, Math.round((pending.expiresAt - Date.now()) / 60_000));
  const host = clientHost();
  return [
    lead,
    "",
    "Show the user this link and code, and ask them to open the link in their browser:",
    "",
    `  Link: ${pending.link}`,
    `  Code: ${pending.userCode}`,
    "",
    "What the user does there:",
    `1. Sign in to Writavo. Someone without an account creates one from the same page (or at ${SIGNUP_URL}), confirms their email and finishes onboarding first; the code is kept for them through all of that. Someone moving an existing blog to Writavo should choose "Bring my existing articles" during onboarding.`,
    `2. Check that the request is from "${CLIENT_NAME}${host ? ` on ${host}` : ""}" and shows the code ${pending.userCode}. Only approve a request they started; if the code differs, deny it.`,
    "3. Choose the Site this assistant should work on, and approve.",
    "",
    `The request expires in about ${minutes} minutes. This server checks for the approval in the background and starts using the new key by itself, with no restart. Call login_status every few seconds to see when it lands.`,
    "",
    `The key will be limited to that one Site and to these scopes: ${pending.scopes.join(", ")}.`,
    ...(pending.note ? ["", pending.note] : []),
  ].join("\n");
}

function describeActiveLogin(): string | null {
  const identity = loginIdentity();
  if (keySource() !== "login" || !identity) return null;
  return [
    `Signed in to the Site "${identity.websiteName}" with key ${identity.keyPrefix}...`,
    `Scopes: ${identity.scopes.join(", ") || "none recorded"}.`,
    identity.expiresAt ? `The key expires on ${identity.expiresAt}.` : "The key has no recorded expiry.",
    identity.path ? `Saved at ${identity.path}.` : "It is held in memory only, because it could not be saved to disk.",
  ].join("\n");
}

const ENV_EXPLANATION =
  "This server is using the key from WRITAVO_API_KEY in the MCP client config, and that key always takes precedence over a browser sign-in. To use login instead, remove WRITAVO_API_KEY from the client config and restart the client.";

export async function handleLogin(rawArgs: ToolArgs): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as { scopes?: string[]; force?: boolean };

  if (envKeyPresent()) {
    return text(`Nothing has been done. ${ENV_EXPLANATION}`);
  }

  if (!args.force) {
    if (state.phase === "pending" && Date.now() < state.expiresAt) {
      return text(pendingInstructions(state, "A sign-in is already waiting for the user's approval. Nothing new was started."));
    }
    const active = describeActiveLogin();
    if (active) {
      return text(
        [
          "Already signed in. Nothing has been done.",
          "",
          active,
          "",
          "Ask the user whether they want to switch to a different Site or account. If they do, call login again with force: true. If the key has stopped working (revoked in the dashboard, for example), force: true is also the fix.",
        ].join("\n"),
      );
    }
  }

  cancelPending();
  const gen = generation;
  const scopes = args.scopes && args.scopes.length > 0 ? [...new Set(args.scopes)] : [...DEFAULT_SCOPES];
  const secret = generateDeviceSecret();

  let start;
  try {
    start = await startDeviceAuthorization(secret, scopes);
  } catch (err) {
    state = { phase: "idle" };
    return formatApiError(err, { tool: "login" });
  }
  if (gen !== generation) return toolError("login was replaced by another sign-in while it started. Call login_status.");

  const intervalMs = Math.max(1, Number(start.interval) || 5) * 1000;
  state = {
    phase: "pending",
    userCode: start.user_code,
    link: verificationLink(start),
    deviceCode: start.device_code,
    expiresAt: Date.now() + Math.max(60, Number(start.expires_in) || 1800) * 1000,
    intervalMs,
    secret,
    scopes,
    note: null,
  };
  schedule(gen, intervalMs);

  return text(
    pendingInstructions(
      state,
      args.force && describeActiveLogin()
        ? "A new sign-in has started. The current one stays in use until this one is approved."
        : "Sign-in started. Nothing is connected yet.",
    ),
  );
}

export function handleLoginStatus(): ToolResult {
  switch (state.phase) {
    case "pending":
      if (Date.now() >= state.expiresAt) {
        cancelPending();
        state = { phase: "expired" };
        return handleLoginStatus();
      }
      return text(pendingInstructions(state, "Waiting for the user to approve in the browser."));
    case "approved": {
      const lines = [
        `Approved. Signed in to the Site "${state.websiteName}" with key ${state.keyPrefix}...`,
        `Scopes: ${state.scopes.join(", ") || "none"}.`,
        state.expiresAt ? `The key expires on ${state.expiresAt}; call login again after that.` : "The key has no recorded expiry.",
      ];
      if (state.savedTo) lines.push(`Saved at ${state.savedTo}, so it survives a restart.`);
      if (state.saveError) {
        lines.push(`It could not be saved to disk (${state.saveError}), so it is in use for this session only.`);
      }
      if (state.shadowedByEnv) {
        lines.push("", `It is NOT in use. ${ENV_EXPLANATION}`);
      } else {
        lines.push("", "Every tool now uses this key. A good next step is get_site_info to confirm the Site.");
      }
      return text(lines.join("\n"));
    }
    case "denied":
      return text("The sign-in request was denied in the browser. Nothing was saved. Call login to start a new one if that was a mistake.");
    case "expired":
      return text("The sign-in request expired before it was approved. Nothing was saved. Call login to start a new one.");
    case "failed":
      return text(state.message);
    default: {
      if (envKeyPresent()) return text(`No browser sign-in is in progress. ${ENV_EXPLANATION}`);
      const active = describeActiveLogin();
      if (active) return text(`No sign-in is in progress. ${active}`);
      return text("Not signed in, and no sign-in is in progress. Call login to start one.");
    }
  }
}

export function handleLogout(): ToolResult {
  const identity = keySource() === "login" ? loginIdentity() : null;
  cancelPending();
  const hadPending = state.phase === "pending";
  state = { phase: "idle" };

  let deleted = false;
  let deleteError: string | null = null;
  try {
    deleted = deleteCredentials();
  } catch (err) {
    deleteError = err instanceof Error ? err.message : String(err);
  }
  deactivateLoginKey();

  const lines: string[] = [];
  if (deleteError) lines.push(`The saved sign-in could not be deleted (${deleteError}). Delete it by hand.`);
  else if (deleted) lines.push("Signed out. The saved sign-in was deleted from this machine and its key is no longer in use.");
  else if (identity) lines.push("Signed out. The key is no longer in use; there was no saved file to delete.");
  else lines.push("There was no saved sign-in on this machine.");
  if (hadPending) lines.push("The sign-in that was waiting for approval was abandoned.");

  if (identity || deleted) {
    lines.push(
      "",
      `The key${identity ? ` (${identity.keyPrefix}..., for "${identity.websiteName}")` : ""} still exists on Writavo and keeps working until it is revoked or expires. To revoke it now, open ${KEYS_URL} and revoke the key named "MCP: ${CLIENT_NAME}${clientHost() ? ` on ${clientHost()}` : ""}".`,
    );
  }
  if (envKeyPresent()) {
    lines.push("", "WRITAVO_API_KEY is still set in the MCP client config, and this server keeps using it. Remove it there to stop.");
  }
  return text(lines.join("\n"));
}
