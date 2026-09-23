import { z } from "zod";
import { apiRequest } from "../api/client.js";
import { BILLING_URL, hasApiKey, keyKind } from "../config.js";
import { text, type ToolResult } from "../errors.js";
import type { ToolArgs } from "./call.js";

/**
 * A link to buy a plan, never a purchase. Payment happens on Stripe's hosted page in the
 * person's own browser; nothing in a chat can spend money on a plan, and this server never sees a
 * card. What it adds over a bare link is the honest framing: most people moving a blog in need no
 * plan at all, because the CMS is pay-as-you-go on every plan (CLAUDE.md golden rule 13).
 */
export const START_PLAN_PURCHASE = {
  name: "start_plan_purchase",
  description:
    "Get the link that lets the user buy or change a Writavo plan in their browser, with a plan and billing interval preselected. It spends nothing and changes nothing: the user reviews the price and pays on Stripe's secure page, never in this chat. A plan buys the AI article pipeline (credits, AI generation, SEO features); storing, publishing and importing content needs no plan. If a key is configured, the reply includes the current plan.",
  inputSchema: {
    plan: z
      .enum(["starter", "growth", "scale"])
      .optional()
      .describe("The plan to preselect. Omit to let the user choose on the page."),
    interval: z
      .enum(["month", "year"])
      .optional()
      .describe("Monthly or yearly billing, to preselect. Omit to let the user choose."),
  },
};

const PLAN_NAMES: Record<string, string> = { starter: "Starter", growth: "Growth", scale: "Scale" };

interface UsageSnapshot {
  plan?: { key?: string; name?: string };
  credits?: { balance?: number };
}

export function planPurchaseLink(plan?: string, interval?: string): string {
  const query = new URLSearchParams();
  if (plan) query.set("plan", plan);
  if (interval) query.set("interval", interval);
  const qs = query.toString();
  return qs ? `${BILLING_URL}?${qs}` : BILLING_URL;
}

export async function handleStartPlanPurchase(rawArgs: ToolArgs): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as { plan?: string; interval?: string };
  const plan = args.plan && PLAN_NAMES[args.plan] ? args.plan : undefined;
  const interval = args.interval === "month" || args.interval === "year" ? args.interval : undefined;
  const link = planPurchaseLink(plan, interval);

  let current: string;
  if (!hasApiKey()) {
    current = "Not signed in, so the current plan is unknown. Call login first if you want it checked.";
  } else if (keyKind() === "publishable") {
    current = "The configured key is publishable, which cannot read the plan, so the current plan is unknown.";
  } else {
    try {
      const usage = await apiRequest<UsageSnapshot>({ method: "GET", path: "/usage" });
      const name = usage.data?.plan?.name ?? usage.data?.plan?.key ?? "unknown";
      const balance = usage.data?.credits?.balance;
      current = `Current plan: ${name}${usage.data?.plan?.key ? ` (${usage.data.plan.key})` : ""}.${typeof balance === "number" ? ` Credit balance: ${balance}.` : ""}`;
    } catch (err) {
      current = `The current plan could not be read (${err instanceof Error ? err.message : String(err)}).`;
    }
  }

  const preselected = [plan ? PLAN_NAMES[plan] : null, interval === "year" ? "yearly" : interval === "month" ? "monthly" : null]
    .filter(Boolean)
    .join(", ");

  return text(
    [
      `Plan purchase link: ${link}`,
      "",
      `Give the user this link. It opens Writavo billing${preselected ? ` with ${preselected} preselected` : ""}. They review the price and pay on Stripe's secure checkout page in their own browser. Payment never happens in this chat, nothing has been bought yet, and this server never sees card details. The person paying needs permission to manage billing for the organisation.`,
      "",
      "Before they buy, make sure they know what a plan is for:",
      "- The CMS (storing, editing, publishing and importing content, media, the read API) is pay-as-you-go on every plan, including Free, and needs no plan at all. Beyond the included allowances it is billed by use, which needs a payment method on file. Someone who only wants to move a blog to Writavo and publish it does not need to buy a plan.",
      "- A plan buys the AI article pipeline: monthly credits, AI article generation and the SEO features.",
      "",
      current,
      "",
      "After they have paid, call get_usage to confirm the plan changed.",
    ].join("\n"),
  );
}
