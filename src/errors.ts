import { WritavoApiError, type ApprovalInfo } from "./api/client.js";
import { ERRORS_BY_CODE } from "./generated/errors.js";
import { AGENTS_URL, BILLING_URL, KEYS_URL } from "./core/constants.js";
import { redact } from "./core/redact.js";

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

/**
 * What to do about the agent-control codes, for as long as the vendored specification predates
 * them. The generated catalog wins whenever it has an entry: this is the fallback, not a second
 * source, and it says the same thing the catalog will once scripts/error-guidance.mjs carries it.
 */
const AGENT_GUIDANCE: Record<string, string> = {
  AGENT_ACCESS_DISABLED: `AI agent access is turned off for this organisation, so no assistant can act on its Sites. Nothing was changed. Tell the user; an owner or admin can turn it back on in Settings > AI agents (${AGENTS_URL}). Do not retry until they have.`,
  APPROVAL_DENIED: "A person denied this request in the Writavo dashboard. Nothing was changed. Do not retry it; tell the user it was denied and ask what they want to do instead.",
  APPROVAL_INVALID: "That approval cannot be used for this request: it expired, was already used, or was given for different arguments. Nothing was changed. Call the same tool again WITHOUT approval_id to ask for a new approval.",
  APPROVAL_REQUIRED: "This action needs a person to approve it in the Writavo dashboard before it runs.",
  APPROVAL_PENDING: "The approval for this action has not been given yet.",
};

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

  // A 428 is not a failure. The request is parked until a person approves it, and the model's job
  // is to hand them the link, so it is answered as an ordinary result the model acts on.
  if (err.status === 428 || err.code === "APPROVAL_REQUIRED" || err.code === "APPROVAL_PENDING") {
    return approvalNeeded(ctx.tool, err);
  }

  const entry = ERRORS_BY_CODE[err.code];
  const lines = [`${ctx.tool} failed: ${err.message}`, ""];

  if (entry?.action) lines.push(`What to do. ${entry.action}`);
  else if (AGENT_GUIDANCE[err.code]) lines.push(`What to do. ${AGENT_GUIDANCE[err.code]}`);
  else lines.push(`What to do. This is the ${err.code} condition. Check ${KEYS_URL} and retry.`);

  // The specifics the catalog cannot know, because they belong to the operation rather than the code.
  if (err.code === "INSUFFICIENT_SCOPE" && ctx.scope && ctx.scope !== "none") {
    lines.push("", `The missing scope is ${ctx.scope}. Add it to the key, or use a key that carries it.`);
  }
  if (err.code === "NOT_ENTITLED" && ctx.entitlement && ctx.entitlement !== "none") {
    lines.push("", `The plan feature this needs is ${ctx.entitlement}. Upgrade at ${BILLING_URL}.`);
  }
  // The catalog speaks HTTP (the Writavo-Approval header); a model speaks tool arguments.
  if (err.code === "APPROVAL_INVALID") {
    lines.push("", `Call ${ctx.tool} again WITHOUT approval_id to ask for a new approval.`);
  }
  if (err.code === "APPROVAL_DENIED") {
    lines.push("", `Do not call ${ctx.tool} again with that approval_id; tell the user it was denied.`);
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
 * The reply to a 428: nothing has happened, a person has to approve it, and here is exactly how
 * the model carries on afterwards. The API binds an approval to the method, the path and the
 * exact body, so the retry must repeat the arguments unchanged, with approval_id added.
 */
export function approvalNeeded(tool: string, err: WritavoApiError): ToolResult {
  const approval: ApprovalInfo | undefined = err.approval;
  const pending = err.code === "APPROVAL_PENDING";
  const lead = pending
    ? `Nothing has been done yet. ${tool} is still waiting for a person to approve it in the Writavo dashboard.`
    : `Nothing has been done yet. ${tool} needs a person to approve it in the Writavo dashboard before it runs. The organisation requires approval for actions like this one when an AI assistant asks for them.`;
  if (!approval) {
    return text(
      [
        lead,
        "",
        `Ask the user to open ${AGENTS_URL}, find the pending approval under AI agents, and approve it. Then call ${tool} again with exactly the same arguments.`,
      ].join("\n"),
    );
  }
  return text(
    [
      lead,
      "",
      "Ask the user to open this link, check what it describes, and approve it:",
      "",
      `  ${approval.url}`,
      "",
      approval.expires_at ? `The approval request expires at ${approval.expires_at}.` : "The approval request expires in a day.",
      `Once the user says they have approved it, call ${tool} again with exactly the same arguments plus approval_id: "${approval.id}". It can be used once, for this exact request. If they deny it, do not retry.`,
    ].join("\n"),
  );
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
