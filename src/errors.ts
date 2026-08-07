import { WritavoApiError } from "./api/client.js";
import { ERRORS_BY_CODE } from "./generated/errors.js";
import { BILLING_URL, KEYS_URL, redact } from "./config.js";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  /** The SDK's result type is open. Declared so a handler is assignable to it. */
  [key: string]: unknown;
}

/** Every reply leaves through here, so nothing reaches a client without passing the redactor. */
export function text(body: string): ToolResult {
  return { content: [{ type: "text", text: redact(body) }] };
}

export function toolError(body: string): ToolResult {
  return { content: [{ type: "text", text: redact(body) }], isError: true };
}

export interface ErrorContext {
  /** The tool the user asked for, so the first line says what failed rather than that something did. */
  tool: string;
  /** The scope the operation needs. Named on an INSUFFICIENT_SCOPE, which is the whole fix. */
  scope?: string;
  /** The plan capability the operation needs. Named on a NOT_ENTITLED. */
  entitlement?: string;
}

/**
 * API-6 §2 "Errors": map the API's codes to actionable text, and never surface a raw HTTP status.
 *
 * The "what to do" line is not written here. It is generated from scripts/error-guidance.mjs, the
 * same source the /docs/errors page renders, so an assistant and the documentation can never give
 * a person two different answers about the same failure.
 */
export function formatApiError(err: unknown, ctx: ErrorContext): ToolResult {
  if (!(err instanceof WritavoApiError)) {
    return toolError(
      `${ctx.tool} failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (err.code === "NETWORK_ERROR") {
    return toolError(`${ctx.tool} could not run. ${err.message}`);
  }

  const entry = ERRORS_BY_CODE[err.code];
  const lines = [`${ctx.tool} failed: ${err.message}`, ""];

  if (entry?.action) lines.push(`What to do. ${entry.action}`);
  else lines.push(`What to do. This is the ${err.code} condition. Check ${KEYS_URL} and retry.`);

  // The specifics the catalog cannot know, because they belong to the operation rather than the code.
  if (err.code === "INSUFFICIENT_SCOPE" && ctx.scope && ctx.scope !== "none") {
    lines.push("", `The missing scope is ${ctx.scope}. Add it to the key, or use a key that carries it.`);
  }
  if (err.code === "NOT_ENTITLED" && ctx.entitlement && ctx.entitlement !== "none") {
    lines.push("", `The plan feature this needs is ${ctx.entitlement}. Upgrade at ${BILLING_URL}.`);
  }
  if (err.code === "RATE_LIMIT_EXCEEDED" && err.retryAfter) {
    lines.push("", `Retry after ${err.retryAfter} seconds.`);
  }
  if (err.fields && Object.keys(err.fields).length > 0) {
    lines.push("", "The fields that were refused:");
    for (const [field, message] of Object.entries(err.fields)) lines.push(`- ${field}: ${message}`);
  }
  for (const link of entry?.links ?? []) lines.push(`- ${link.label}: ${link.url}`);
  if (err.requestId) lines.push("", `Quote this if you contact support: ${err.requestId}`);

  return toolError(lines.join("\n"));
}

/**
 * The refusal a publishable key gets, produced without a network call.
 *
 * The API would answer 403 INSUFFICIENT_SCOPE for exactly this, and the wording matches, but a
 * publishable key is admitted to a fixed set of operations regardless of its scopes, so there is
 * nothing to learn from asking. The person gets the same answer a round trip would have given
 * them, one second sooner, and the key is not sent somewhere it was always going to be refused.
 */
export function publishableKeyRefusal(tool: string, scope: string): ToolResult {
  const entry = ERRORS_BY_CODE.INSUFFICIENT_SCOPE;
  return toolError(
    [
      `${tool} failed: this is a publishable key (wv_pub_), which is read only and limited to published content.`,
      "",
      `What to do. ${entry?.action ?? ""}`,
      "",
      `The missing scope is ${scope}. A publishable key can never carry a write scope, whatever it is granted, so this needs a secret key (wv_sk_).`,
      `- Create a secret key: ${KEYS_URL}`,
    ].join("\n"),
  );
}
