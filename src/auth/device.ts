import { createHash, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { apiRequest } from "../api/client.js";
import { DEVICE_URL, rememberSecret } from "../config.js";
import { forTool } from "../core/context.js";
import { friendlyClientName } from "../core/client-name.js";
import { STDIO_CONTEXT } from "../stdio/context.js";

/**
 * Browser sign-in, the device authorization flow (RFC 8628) with one change that matters: the
 * SECRET IS MADE HERE. This machine generates the key, sends only its sha256 to be approved, and
 * the key that comes into force on approval is one that never crossed the network. Neither the
 * approval page nor the polling endpoint ever holds a usable credential.
 *
 * The CLI carries a copy of this file (packages/cli/src/device.ts); the packages are published
 * separately and neither may import the other.
 *
 * Stdio host only (node:crypto randomBytes, node:os hostname). The hosted server signs people in
 * with OAuth on the Worker instead, and never imports this.
 */

/** What login asks for when the caller names nothing. Never keys:* or webhooks:*. */
export const DEFAULT_SCOPES = [
  "articles:read",
  "articles:write",
  "taxonomy:read",
  "taxonomy:write",
  "authors:read",
  "authors:write",
  "media:read",
  "media:write",
  "pipeline:read",
  "pipeline:run",
  "meta:read",
] as const;

export type LoginScope = (typeof DEFAULT_SCOPES)[number];

/**
 * Where the MCP client's own name comes from: the stdio server wires this to the initialize
 * handshake's clientInfo.name. Unset (a test, or a call before initialize) means "AI assistant".
 */
let clientInfoName: () => string | undefined = () => undefined;

export function setClientInfoSource(source: () => string | undefined): void {
  clientInfoName = source;
}

/**
 * The key's name, after the app that holds it (Addendum B): "Claude Code (local MCP)". Shown on
 * the approval page and in Settings > API keys and AI agents, so a person can see which app has one.
 */
export function clientName(): string {
  return `${friendlyClientName(clientInfoName())} (local MCP)`;
}

export interface DeviceSecret {
  secret: string;
  hash: string;
  prefix: string;
}

/** "wv_sk_" + 32 base64url characters from 24 random bytes: exactly the server's own key format. */
export function generateDeviceSecret(): DeviceSecret {
  const secret = `wv_sk_${randomBytes(24).toString("base64url")}`;
  // Known to the redactor from this moment, so the pending key cannot leak into any reply.
  rememberSecret(secret);
  return {
    secret,
    hash: createHash("sha256").update(secret).digest("hex"),
    prefix: secret.slice(0, 12),
  };
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DeviceToken =
  | { status: "pending" }
  | { status: "slow_down"; interval?: number }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "approved";
      key: { id: string; key_prefix: string; scopes: string[]; expires_at: string | null };
      website: { id: string; name: string };
    };

export function clientHost(): string | undefined {
  try {
    const host = hostname().trim();
    return host ? host.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The link shown to the person. Taken from the server only when it points at the dashboard, and
 * rebuilt from the code otherwise: this is the one URL a person is asked to open and sign in at,
 * so it is never somewhere other than app.writavo.com.
 */
export function verificationLink(start: Pick<DeviceStart, "user_code" | "verification_uri_complete">): string {
  const offered = start.verification_uri_complete;
  if (typeof offered === "string" && offered.startsWith(`${DEVICE_URL}?`)) return offered;
  return `${DEVICE_URL}?code=${encodeURIComponent(start.user_code)}`;
}

export async function startDeviceAuthorization(secret: DeviceSecret, scopes: readonly string[]): Promise<DeviceStart> {
  const host = clientHost();
  const response = await apiRequest<DeviceStart>(forTool(STDIO_CONTEXT, "login"), {
    method: "POST",
    path: "/auth/device",
    auth: false,
    body: {
      client_name: clientName(),
      ...(host ? { client_host: host } : {}),
      key_hash: secret.hash,
      key_prefix: secret.prefix,
      scopes,
    },
  });
  return response.data;
}

export async function pollDeviceToken(deviceCode: string): Promise<DeviceToken> {
  const response = await apiRequest<DeviceToken>(forTool(STDIO_CONTEXT, "login"), {
    method: "POST",
    path: "/auth/device/token",
    auth: false,
    body: { device_code: deviceCode },
  });
  return response.data;
}
