import { CONFIG, redact } from "../config.js";

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    fields?: Record<string, string>;
    request_id?: string;
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
  ) {
    // Redacted at construction rather than at the point of display, so there is no path from an
    // error to a log line that skipped the masking step.
    super(redact(message));
    this.name = "WritavoApiError";
  }
}

export interface ApiRequest {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path relative to the base URL, already filled in. */
  path: string;
  /** Repeated keys are sent as repeated parameters, which is what the spec's array filters expect. */
  query?: [string, string][];
  body?: unknown;
  headers?: Record<string, string>;
}

export interface ApiResponse<T> {
  status: number;
  data: T;
  etag: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The only place this package talks to the network. Adds the bearer key, parses the API's
 * `{ok, data}` / `{ok, error}` envelope into a value or a typed exception, and retries once on a
 * 429 while honouring Retry-After.
 */
export async function apiRequest<T>(request: ApiRequest): Promise<ApiResponse<T>> {
  if (request.path.includes("..") || request.path.includes("//")) {
    throw new WritavoApiError("INVALID_REQUEST", "The request path is not valid.", 400);
  }

  const url = new URL(`${CONFIG.apiBaseUrl}${request.path}`);
  for (const [key, value] of request.query ?? []) url.searchParams.append(key, value);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${CONFIG.apiKey}`,
    Accept: "application/json",
    "User-Agent": "writavo-mcp-server",
    ...(request.headers ?? {}),
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  const send = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.requestTimeoutMs);
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
    throw new WritavoApiError("NETWORK_ERROR", networkMessage(err), 0);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitMs = retryAfter ? Number.parseInt(retryAfter, 10) * 1000 : 5000;
    await sleep(Math.min(Number.isFinite(waitMs) ? waitMs : 5000, CONFIG.maxRetryWaitMs));
    try {
      response = await send();
    } catch (err) {
      throw new WritavoApiError("NETWORK_ERROR", networkMessage(err), 0);
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
    );
  }

  const envelope = payload as { ok?: boolean; data?: T };
  return { status: response.status, data: (envelope?.data ?? (payload as T)), etag };
}

/**
 * A fetch failure carries the request URL, and the URL is the one place a credential could ride
 * along in future. Rewritten rather than interpolated.
 */
function networkMessage(err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  if (reason.includes("aborted") || reason.includes("abort")) {
    return "The request to the Writavo API timed out. Try again in a moment.";
  }
  return `Could not reach the Writavo API at ${CONFIG.apiBaseUrl}. Check the machine has network access.`;
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
