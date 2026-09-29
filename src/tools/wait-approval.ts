import { z } from "zod";
import { apiRequest, WritavoApiError } from "../api/client.js";
import { forTool, hasKey, type ToolContext } from "../core/context.js";
import { text, toolError, type ToolResult } from "../errors.js";
import type { ToolArgs } from "./call.js";

/**
 * Wait, inside one call, for a person to decide an approval (0146). Before this, a 428 ended the
 * turn: the assistant showed the link, the person approved, and then had to come back and type
 * "done" before anything happened. Now the assistant shows the link and calls this; it returns
 * the moment the person decides (in the dashboard, on the approval page, or with "Approve all"),
 * and the assistant carries on by itself.
 *
 * It only READS the approval (GET /approvals/{id}, readable by the key that asked and nobody
 * else) and never decides it: the approval is still a person's click in the signed-in dashboard.
 * The poll is bounded by time and by request count, because a hosted call may make at most ~50
 * outbound requests on Cloudflare's free plan.
 */
export const WAIT_FOR_APPROVAL = {
  name: "wait_for_approval",
  description:
    "Wait for a person to approve or deny an action you were told needs approval (a reply with an approval link and approval_id). Show the user the link first, then call this: it returns as soon as they decide, so they do not have to come back and tell you. On approved, call the original tool again with exactly the same arguments plus approval_id. On denied, stop and do not retry. If it is still pending when the wait ends, you may call it again or ask the user. It never approves anything itself.",
  inputSchema: {
    approval_id: z.string().uuid().describe("The approval_id from the reply that asked for approval."),
    timeout_seconds: z
      .number()
      .int()
      .min(10)
      .max(120)
      .optional()
      .describe("How long to wait, 10 to 120 seconds. Default 90."),
  },
};

const DEFAULT_TIMEOUT_S = 90;
/** Polls per call, under the hosted server's outbound request cap with room to spare. */
const MAX_POLLS = 30;

interface ApprovalStatus {
  id: string;
  action: string;
  status: "pending" | "approved" | "denied" | "used" | "expired" | string;
  expires_at: string | null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 3 s for the first 30 s (a person who is already looking), then 5 s. */
const intervalAt = (elapsedMs: number) => (elapsedMs < 30_000 ? 3_000 : 5_000);

export async function handleWaitForApproval(ctx: ToolContext, rawArgs: ToolArgs): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as { approval_id?: unknown; timeout_seconds?: unknown };
  const id = typeof args.approval_id === "string" ? args.approval_id.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    return toolError("wait_for_approval needs the approval_id (a UUID) from the reply that asked for approval.");
  }
  if (!hasKey(ctx)) return toolError(ctx.notSignedIn());

  const requested = typeof args.timeout_seconds === "number" && Number.isFinite(args.timeout_seconds)
    ? Math.min(120, Math.max(10, Math.floor(args.timeout_seconds)))
    : DEFAULT_TIMEOUT_S;
  const started = Date.now();
  let until = started + requested * 1000;
  if (ctx.deadline !== undefined) until = Math.min(until, ctx.deadline - 2_000);

  const link = `https://app.writavo.com/approvals/${id}`;
  let last: ApprovalStatus | null = null;
  for (let poll = 0; poll < MAX_POLLS; poll++) {
    try {
      const res = await apiRequest<ApprovalStatus>(forTool(ctx, WAIT_FOR_APPROVAL.name), {
        method: "GET",
        path: `/approvals/${encodeURIComponent(id)}`,
      });
      last = res.data;
    } catch (err) {
      if (err instanceof WritavoApiError && err.status === 404) {
        return toolError(
          `There is no approval ${id} for this connection. Use the approval_id from the reply that asked for approval, from this same connection.`,
        );
      }
      if (err instanceof WritavoApiError && err.status === 403) {
        return toolError(`wait_for_approval could not read the approval: ${err.message}`);
      }
      // A transient failure: keep waiting unless time is up.
    }

    if (last && last.status !== "pending") break;
    const next = intervalAt(Date.now() - started);
    if (Date.now() + next > until) break;
    await sleep(next);
  }

  const waited = Math.round((Date.now() - started) / 1000);
  switch (last?.status) {
    case "approved":
      return text(
        [
          `Approved by a person (after ${waited} s).`,
          "",
          `Now call the original tool again with exactly the same arguments plus approval_id: "${id}". It can be used once, for that exact request. Do not change any argument, or it will not match.`,
        ].join("\n"),
      );
    case "denied":
      return text(`Denied. The person said no to this action. Do not retry it; tell the user it was not done and ask how they want to proceed.`);
    case "used":
      return text(`This approval has already been used (the action ran). Do not run it again with the same approval_id.`);
    case "expired":
      return text(
        `This approval expired before it was used. If the user still wants it, call the original tool again WITHOUT approval_id to ask for a new one.`,
      );
    default:
      return text(
        [
          `Still waiting after ${waited} s: nobody has approved or denied it yet.`,
          "",
          `Remind the user of the link: ${link}`,
          "Then call wait_for_approval again with the same approval_id to keep waiting, or ask the user to tell you once they have decided.",
        ].join("\n"),
      );
  }
}
