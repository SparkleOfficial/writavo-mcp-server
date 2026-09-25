import { MAX_RETRY_WAIT_MS, REQUEST_TIMEOUT_MS } from "../core/constants.js";
import type { ToolContext } from "../core/context.js";
import { redact } from "../core/redact.js";

/**
 * What a 428 carries: an approval a person has to give in the dashboard before the request runs.
 * Only a key an AI agent signed in with (device or OAuth) is ever asked for one.
 */
export interface ApprovalInfo {
  id: string;
  url: string;
  expires_at: string | null;
  status: string;
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    request_id?: string;
    approval?: Partial<ApprovalInfo>;
  };
}

export class WritavoApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public fields?: Record<string, string>,
    public requestId?: string,
    public retryAfter?: string,
    public approval?: ApprovalInfo,
  ) {
    // Redacted at construction rather than at the point of display, so there is no path from an
    // error to a log line that skipped the masking step.
    super(redact(message));
    this.name = "WritavoApiError";
  }
}

export interface ApiRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to the base URL, already filled in. */
  path: string;
  /** Repeated keys are sent as repeated parameters, which is what the spec's array filters expect. */
  query?: [string, string][];
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * False for the two sign-in endpoints, which take no key. Nothing is sent rather than whatever
   * key happens to be active, because a request that needs no credential should not carry one.
   */
  auth?: boolean;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  etag: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Headers a host may never set through extraHeaders, whether or not the core set them this time. */
const PROTECTED_HEADERS = new Set(["authorization", "writavo-mcp-tool"]);

/**
 * The host's own headers (the Worker's credential and the end user's IP), added last and only
 * where the core has not already spoken: a host can add to a request, never rewrite it.
 */
function mergeHostHeaders(headers: Record<string, string>, ctx: ToolContext): void {
  if (!ctx.extraHeaders) return;
  const taken = new Set(Object.keys(headers).map((k) => k.toLowerCase()));
  for (const [name, value] of Object.entries(ctx.extraHeaders() ?? {})) {
    const lower = name.toLowerCase();
    if (PROTECTED_HEADERS.has(lower) || taken.has(lower) || typeof value !== "string") continue;
    headers[name] = value;
    taken.add(lower);
  }
}

/** The shape the API's tool-name header accepts, so a malformed one is never sent at all. */
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The only place this package talks to the network. Adds the bearer key, parses the API's
 * `{ok, data}` / `{ok, error}` envelope into a value or a typed exception, and retries once on a
 * 429 while honouring Retry-After.
 *
 * The key, the base URL and the user agent come from the context, never from a global, because
 * the hosted server runs many people's requests side by side in one process.
 */
export async function apiRequest<T>(ctx: ToolContext, request: ApiRequest): Promise<ApiResponse<T>> {
  if (request.path.includes("..") || request.path.includes("//")) {
    throw new WritavoApiError("INVALID_REQUEST", "The request path is not valid.", 400);
  }

  const url = new URL(`${ctx.apiBase}${request.path}`);
  for (const [key, value] of request.query ?? []) url.searchParams.append(key, value);

  const headers: Record<string, string> = {
    ...(request.auth === false ? {} : { Authorization: `Bearer ${ctx.apiKey()}` }),
    Accept: "application/json",
    "User-Agent": ctx.userAgent,
    // Logging only: the API records which tool made a call in the organisation's agent call log.
    // It is never a decision input there, so a client that omits it loses nothing but a label.
    ...(ctx.tool && TOOL_NAME.test(ctx.tool) ? { "Writavo-Mcp-Tool": ctx.tool } : {}),
    ...(request.headers ?? {}),
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  mergeHostHeaders(headers, ctx);

  const send = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let response: Response;
  try {
    response = await send();
  } catch (err) {
    throw new WritavoApiError("NETWORK_ERROR", networkMessage(err, ctx.apiBase), 0);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
    await sleep(Math.min(Number.isFinite(waitMs) ? waitMs : 5000, MAX_RETRY_WAIT_MS));
    try {
      response = await send();
    } catch (err) {
      throw new WritavoApiError("NETWORK_ERROR", networkMessage(err, ctx.apiBase), 0);
    }
  }

  const etag = response.headers.get("ETag");

  if (response.status === 204) {
    return { status: 204, data: undefined as T, etag };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (response.ok) return { status: response.status, data: undefined as T, etag };
    throw new WritavoApiError(
      "INTERNAL_ERROR",
      `The API returned status ${response.status} and a body that is not JSON.`,
      response.status,
    );
  }

  if (!response.ok) {
    const body = payload as ApiErrorBody;
    throw new WritavoApiError(
      body?.error?.code || "INTERNAL_ERROR",
      body?.error?.message || `The API returned status ${response.status}.`,
      response.status,
      body?.error?.fields,
      body?.error?.request_id,
      response.headers.get("Retry-After") ?? undefined,
      approvalOf(body?.error?.approval),
    );
  }

  const envelope = payload as { ok?: boolean; data?: T };
  return { status: response.status, data: (envelope?.data ?? (payload as T)), etag };
}

/** The one place an approval link may point: the dashboard's approval page for that id. */
const APPROVAL_ORIGIN = "https://app.writavo.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The approval object of a 428, kept only when it is usable. The link is shown to a person and
 * they are asked to sign in there, so it is pinned to exactly https://app.writavo.com/approvals/<id>.
 * Not "any *.writavo.com": tenants control <slug>.writavo.com hosted blogs, so a subdomain match
 * would let a Site's own pages pose as the approval screen. Any other URL is replaced: the link
 * is rebuilt from the id every time, so what the API sent in `url` never decides where a person
 * is sent.
 */
function approvalOf(raw: Partial<ApprovalInfo> | undefined): ApprovalInfo | undefined {
  if (!raw || typeof raw.id !== "string" || !UUID.test(raw.id)) return undefined;
  const id = raw.id.toLowerCase();
  // Always rebuilt from the id. The only acceptable link is exactly this one, so the API's own
  // `url` can at best agree with it, and a link that disagrees is never shown.
  const url = `${APPROVAL_ORIGIN}/approvals/${id}`;
  return {
    id,
    url,
    expires_at: typeof raw.expires_at === "string" ? raw.expires_at : null,
    status: typeof raw.status === "string" ? raw.status : "pending",
  };
}

/**
 * A fetch failure carries the request URL, and the URL is the one place a credential could ride
 * along in future. Rewritten rather than interpolated.
 */
function networkMessage(err: unknown, apiBase: string): string {
  const reason = err instanceof Error ? err.message : String(err);
  if (reason.includes("aborted") || reason.includes("abort")) {
    return "The request to the Writavo API timed out. Try again in a moment.";
  }
  return `Could not reach the Writavo API at ${apiBase}. Check the network is reachable.`;
}

/** Upload raw bytes to a presigned URL. Deliberately sends no Authorization header. */
export async function putPresigned(
  uploadUrl: string,
  bytes: Uint8Array,
  headers: Record<string, string>,
): Promise<void> {
  const parsed = new URL(uploadUrl);
  if (parsed.protocol !== "https:") {
    throw new WritavoApiError("INVALID_REQUEST", "The upload URL is not https.", 400);
  }
  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "PUT",
      headers,
      body: bytes,
    });
  } catch (err) {
    throw new WritavoApiError(
      "NETWORK_ERROR",
      `Could not upload the file to storage: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }
  if (!response.ok) {
    // The signature in the URL is the credential, so the body of a failure can echo it back.
    throw new WritavoApiError(
      "INTERNAL_ERROR",
      `Storage refused the upload with status ${response.status}. The upload URL may have expired; request a new one and retry.`,
      response.status,
    );
  }
}
