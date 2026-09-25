// error-guidance — what to DO about each error code, and where to go to fix it.
//
// openapi.yaml's ErrorCode table says what a code MEANS. This says what to change, which is what
// somebody in the middle of an outage actually needs. It is the one piece of error copy the spec
// does not already carry, so it is authored exactly once, here, and generated into every surface
// that shows it:
//
//   scripts/gen-api-docs.mjs   -> apps/marketing/lib/docs/generated.ts -> the /docs/errors page
//   scripts/gen-mcp-tools.mjs  -> packages/mcp/src/generated/errors.ts -> the MCP server's replies
//
// `scripts/check-docs-drift.mjs` rule 8 asserts these keys are exactly openapi.yaml's ErrorCode
// enum, so a code added to the API cannot ship without an answer, and an answer cannot outlive the
// code it answers for.

/** Code -> what to change. Prose, rendered as-is on the docs page and in an MCP tool reply. */
export const ERROR_GUIDANCE = {
  INVALID_REQUEST:
    "Fix the request before retrying. Common causes: a body that is not JSON, an unknown value in a query parameter, a cursor you constructed rather than passed back, or a missing `Idempotency-Key` on a creating POST.",
  INVALID_API_KEY:
    "Check the key is present, complete, and sent as `Authorization: Bearer <key>`. This response never distinguishes a missing key from a wrong one, so you cannot tell from it which mistake you made.",
  API_KEY_REVOKED:
    "Someone revoked or rotated this key. Create a new one in the dashboard and update your integration. Nothing you can send will make this key work again.",
  API_KEY_EXPIRED:
    "The key passed its `expires_at`. Create a replacement. If you did not expect an expiry, check whether the key was created with one.",
  INSUFFICIENT_SCOPE:
    "Either the key lacks the scope, or its creator's permissions no longer cover it. Check `GET /keys` for the scopes actually granted, then check the creator still has the matching dashboard permission. This is the only 403 in the API, and it never means the object belongs to someone else.",
  NOT_ENTITLED:
    "Your plan does not include this capability. Upgrading is the only fix; topping up credits will not help. This is answered before the credit check, so it tells you nothing about your balance.",
  INSUFFICIENT_CREDITS:
    "The organisation cannot afford the next unit of work. Top up. The balance is shared by every Site under the account, so another Site may have spent it.",
  SPEND_CAP_REACHED:
    "This Site hit the monthly ceiling you configured for it, not a platform limit. Raise the cap in the dashboard or wait for the period to reset. `GET /usage` shows the cap, what has been spent against it, and whether it is reached.",
  PAYMENT_METHOD_REQUIRED:
    "You have used everything included with your account for this resource, and there is no payment method on file to bill the rest to. Add a card and retry; the same request will then succeed. This is not a plan limit and upgrading will not fix it: storage, documents, seats, Sites and domains are pay-as-you-go on every plan including Free, so the fix is a card rather than a tier. Nothing you have already published stops serving while this is outstanding, and `GET /usage` shows which resource ran out and what the next unit costs.",
  NOT_FOUND:
    "Either there is no such object, or it belongs to a different Site. If you are certain the id is right, check you are using the key for the correct Site.",
  SLUG_CONFLICT:
    "Another object on this Site already uses that slug. Pick a different one, or let the API derive one by omitting `slug`.",
  IDEMPOTENCY_KEY_CONFLICT:
    "You reused a key with a different body. That is a bug in the client rather than a retry: generate one key per logical operation and reuse it only to repeat that same operation.",
  IDEMPOTENCY_KEY_IN_FLIGHT:
    "The first request with this key is still running. Wait a moment and retry with the same key; you will get the original response replayed.",
  CONFLICT:
    "The request clashes with the object's current state. Read `error.message` first: when it names the step to take (for example \"This article is live. Unpublish it first.\"), do that step, then retry. Otherwise the object changed mid request: re-read it and retry.",
  PRECONDITION_FAILED:
    "Your `If-Match` did not match, so someone edited the object since you read it. Nothing was written. Re-read, merge your change on top, and retry with the new `ETag`.",
  VALIDATION_FAILED:
    "Read `error.fields`. It maps each offending field to a message you can show next to the input. The three most common causes are publishing without a title, slug or content; scheduling in the past; and sending `status`, which is read only.",
  RATE_LIMIT_EXCEEDED:
    "Back off and honour `Retry-After`. Watch `RateLimit-Remaining` on successful responses so you can slow down before you are refused rather than after.",
  MAINTENANCE:
    "Writes are paused. Reads usually keep working and your published blog is served from cache, so your site stays up. Retry after the window in `Retry-After`.",
  INTERNAL_ERROR:
    "Ours, not yours. Safe to retry, and safer with the same `Idempotency-Key`, which guarantees you do not create a second object if the first request actually succeeded. Quote the `request_id` if you contact support.",
  FORBIDDEN:
    "Read the message: it names the reason and what to do instead. On `POST /auth/key/extend` the key is not one that may extend itself (only a live key from a device or AI-assistant sign-in can), its creator can no longer manage API keys, or AI agent access is off; signing in again gets a fresh key. On `POST /auth/device` it means `flow` was set to `oauth`, which only Writavo's hosted MCP server may do: leave `flow` out.",
  AGENT_ACCESS_DISABLED:
    "An owner or admin turned AI agent access off for this organisation. Nothing you send will work until it is turned back on in Settings > AI agents; the key itself is fine and needs no new sign-in once it is. Keys made in the dashboard are not affected.",
  APPROVAL_REQUIRED:
    "Nothing has happened yet. Show the person `error.approval.url`, where they can approve or deny this exact request. Once they approve, send the identical request again with the header `Writavo-Approval: <error.approval.id>`. Do not change the path or the body, and do not retry in a loop: an approval lasts 24 hours.",
  APPROVAL_PENDING:
    "The person has not decided yet. Wait for them to approve at `error.approval.url`, then retry with the same `Writavo-Approval` id. Polling will not speed it up.",
  APPROVAL_DENIED:
    "A person looked at this request and said no. Do not retry it, and do not rephrase it to get around the refusal; ask them what they would like instead.",
  APPROVAL_INVALID:
    "The approval id you sent is expired, already used, for a different request, or unknown. Approvals are single use and bound to the exact request. Retry without `Writavo-Approval` to ask for a new one.",
};

/**
 * Where a person goes to fix it. Only for codes a human can act on from the dashboard: a link on
 * `CONFLICT` would be noise. These are product URLs rather than contract, which is why they live
 * beside the guidance and not in openapi.yaml.
 */
const DASHBOARD = "https://app.writavo.com";
const DOCS = "https://writavo.com/docs";

export const ERROR_LINKS = {
  INVALID_API_KEY: [{ label: "Your API keys", url: `${DASHBOARD}/settings/api-keys` }],
  API_KEY_REVOKED: [{ label: "Create a replacement key", url: `${DASHBOARD}/settings/api-keys` }],
  API_KEY_EXPIRED: [{ label: "Create a replacement key", url: `${DASHBOARD}/settings/api-keys` }],
  INSUFFICIENT_SCOPE: [
    { label: "Your API keys and their scopes", url: `${DASHBOARD}/settings/api-keys` },
    { label: "How scopes work", url: `${DOCS}/authentication` },
  ],
  NOT_ENTITLED: [{ label: "Plans and upgrades", url: `${DASHBOARD}/billing` }],
  INSUFFICIENT_CREDITS: [{ label: "Top up credits", url: `${DASHBOARD}/billing` }],
  SPEND_CAP_REACHED: [{ label: "Your spend cap", url: `${DASHBOARD}/billing` }],
  PAYMENT_METHOD_REQUIRED: [{ label: "Add a payment method", url: `${DASHBOARD}/billing` }],
  RATE_LIMIT_EXCEEDED: [{ label: "The rate limit classes", url: `${DOCS}/rate-limits` }],
  VALIDATION_FAILED: [{ label: "The content lifecycle", url: `${DOCS}/content-lifecycle` }],
  AGENT_ACCESS_DISABLED: [{ label: "AI agent settings", url: `${DASHBOARD}/settings/agents` }],
  APPROVAL_PENDING: [{ label: "AI agent settings", url: `${DASHBOARD}/settings/agents` }],
};
