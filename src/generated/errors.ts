// GENERATED FILE. Do not edit.
//   source: openapi.yaml + scripts/error-guidance.mjs
//   regenerate: pnpm mcp:gen
//
// `pnpm docs:check` rule 12 re-runs the generator and diffs it against what is committed, so
// a hand edit here fails CI rather than quietly becoming a second copy of the contract.

export interface ErrorLink {
  label: string;
  url: string;
}

export interface ErrorEntry {
  code: string;
  http: string;
  /** What the code means. From the spec. */
  meaning: string;
  /** What to change. From scripts/error-guidance.mjs, the same source the docs page renders. */
  action: string;
  links: ErrorLink[];
}

export const ERROR_CATALOG: ErrorEntry[] = [
  {
    "code": "INVALID_REQUEST",
    "http": "400",
    "meaning": "Malformed JSON, a bad parameter, or a missing required header.",
    "action": "Fix the request before retrying. Common causes: a body that is not JSON, an unknown value in a query parameter, a cursor you constructed rather than passed back, or a missing `Idempotency-Key` on a creating POST.",
    "links": []
  },
  {
    "code": "INVALID_API_KEY",
    "http": "401",
    "meaning": "No key, an unparseable key, or one that does not exist.",
    "action": "Check the key is present, complete, and sent as `Authorization: Bearer <key>`. This response never distinguishes a missing key from a wrong one, so you cannot tell from it which mistake you made.",
    "links": [
      {
        "label": "Your API keys",
        "url": "https://app.writavo.com/settings/api-keys"
      }
    ]
  },
  {
    "code": "API_KEY_REVOKED",
    "http": "401",
    "meaning": "The key was revoked or rotated past its grace window.",
    "action": "Someone revoked or rotated this key. Create a new one in the dashboard and update your integration. Nothing you can send will make this key work again.",
    "links": [
      {
        "label": "Create a replacement key",
        "url": "https://app.writavo.com/settings/api-keys"
      }
    ]
  },
  {
    "code": "API_KEY_EXPIRED",
    "http": "401",
    "meaning": "The key passed its expires_at.",
    "action": "The key passed its `expires_at`. Create a replacement. If you did not expect an expiry, check whether the key was created with one.",
    "links": [
      {
        "label": "Create a replacement key",
        "url": "https://app.writavo.com/settings/api-keys"
      }
    ]
  },
  {
    "code": "INSUFFICIENT_SCOPE",
    "http": "403",
    "meaning": "The key is valid but lacks the scope this operation needs. For an AI agent, the message names the permission row the person must set to Read or Read and write when they reconnect.",
    "action": "Either the key lacks the scope, or its creator's permissions no longer cover it. Check `GET /ping` for the scopes the key carries now, then check the creator still has the matching dashboard permission. It never means the object belongs to someone else. For an AI agent, the message names the permission row (for example \"SEO and outreach\" or \"Team and organisation\") the person must set to Read or Read and write when they connect the assistant again; tell them that, and do not retry until they have.",
    "links": [
      {
        "label": "Your API keys and their scopes",
        "url": "https://app.writavo.com/settings/api-keys"
      },
      {
        "label": "How scopes work",
        "url": "https://writavo.com/docs/authentication"
      }
    ]
  },
  {
    "code": "FORBIDDEN",
    "http": "403",
    "meaning": "Refused for a reason no scope would change: a key that may not extend itself, an OAuth sign-in not started by Writavo's MCP server, an AI agent changing the access of the person it acts for, anything to do with ownership, or a setting only a person may change. The message says which and what to do instead.",
    "action": "Read the message: it names the reason and what to do instead, and no scope or retry changes it. On the team and permission operations it means an AI agent tried to change the access of the person it acts for, or something to do with ownership, or a change the caller's own role does not allow: a person makes that change at https://app.writavo.com/team. On a setting only a person may change (the AI agent controls, the outreach policy) a person does it in the dashboard at the page the message names. On `POST /auth/key/extend` the key is not one that may extend itself (only a live key from a device or AI-assistant sign-in can), its creator can no longer manage API keys, or AI agent access is off; signing in again gets a fresh key. On `POST /auth/device` it means `flow` was set to `oauth`, which only Writavo's hosted MCP server may do: leave `flow` out.",
    "links": [
      {
        "label": "The team and roles",
        "url": "https://app.writavo.com/team"
      }
    ]
  },
  {
    "code": "AGENT_ACCESS_DISABLED",
    "http": "403",
    "meaning": "The key belongs to an AI agent and the organisation has turned AI agent access off.",
    "action": "An owner or admin turned AI agent access off for this organisation. Nothing you send will work until it is turned back on in Settings > AI agents; the key itself is fine and needs no new sign-in once it is. Keys made in the dashboard are not affected.",
    "links": [
      {
        "label": "AI agent settings",
        "url": "https://app.writavo.com/settings/agents"
      }
    ]
  },
  {
    "code": "APPROVAL_REQUIRED",
    "http": "428",
    "meaning": "An AI agent asked for an action a person must approve. error.approval has the link and the id to retry with.",
    "action": "Nothing has happened yet. Show the person `error.approval.url`, where they can approve or deny this exact request. Once they approve, send the identical request again with the header `Writavo-Approval: <error.approval.id>`. Do not change the path or the body, and do not retry in a loop: an approval lasts 24 hours.",
    "links": []
  },
  {
    "code": "APPROVAL_PENDING",
    "http": "428",
    "meaning": "The approval you sent has not been decided yet. Retry once it has.",
    "action": "The person has not decided yet. Wait for them to approve at `error.approval.url`, then retry with the same `Writavo-Approval` id. Polling will not speed it up.",
    "links": [
      {
        "label": "AI agent settings",
        "url": "https://app.writavo.com/settings/agents"
      }
    ]
  },
  {
    "code": "APPROVAL_DENIED",
    "http": "403",
    "meaning": "A person denied the action.",
    "action": "A person looked at this request and said no. Do not retry it, and do not rephrase it to get around the refusal; ask them what they would like instead.",
    "links": []
  },
  {
    "code": "APPROVAL_INVALID",
    "http": "409",
    "meaning": "The approval you sent cannot be used for this request: expired, already used, for a different request, unknown, or what the request would do has changed since it was approved.",
    "action": "The approval id you sent is expired, already used, for a different request, unknown, or what the request would do has changed since it was approved (\"What this request would do has changed...\"). Approvals are single use and bound to the exact request and its effect. Retry without `Writavo-Approval` to ask for a new one, and tell the person what changed.",
    "links": []
  },
  {
    "code": "NOT_ENTITLED",
    "http": "402",
    "meaning": "Your plan does not include this AI pipeline capability. Upgrade. CMS capabilities are on every plan and never return this.",
    "action": "Your plan does not include this capability. Upgrading is the only fix; topping up credits will not help. This is answered before the credit check, so it tells you nothing about your balance.",
    "links": [
      {
        "label": "Plans and upgrades",
        "url": "https://app.writavo.com/billing"
      }
    ]
  },
  {
    "code": "INSUFFICIENT_CREDITS",
    "http": "402",
    "meaning": "The organisation cannot afford the next unit of work. Top up.",
    "action": "The organisation cannot afford the next unit of work. Top up. The balance is shared by every Site under the account, so another Site may have spent it.",
    "links": [
      {
        "label": "Top up credits",
        "url": "https://app.writavo.com/billing"
      }
    ]
  },
  {
    "code": "SPEND_CAP_REACHED",
    "http": "402",
    "meaning": "This Site hit its own monthly ceiling. Raise it or wait.",
    "action": "This Site hit the monthly ceiling you configured for it, not a platform limit. Raise the cap in the dashboard or wait for the period to reset. `GET /usage` shows the cap, what has been spent against it, and whether it is reached.",
    "links": [
      {
        "label": "Your spend cap",
        "url": "https://app.writavo.com/billing"
      }
    ]
  },
  {
    "code": "PAYMENT_METHOD_REQUIRED",
    "http": "402",
    "meaning": "This would go past your included CMS allowance and there is no payment method on file. Not a plan limit and not an upgrade: CMS resources are pay-as-you-go on every plan. Add a card and retry. Nothing already published stops serving.",
    "action": "You have used everything included with your account for this resource, and there is no payment method on file to bill the rest to. Add a card and retry; the same request will then succeed. This is not a plan limit and upgrading will not fix it: storage, documents, seats, Sites and domains are pay-as-you-go on every plan including Free, so the fix is a card rather than a tier. Nothing you have already published stops serving while this is outstanding, and `GET /usage` shows which resource ran out and what the next unit costs.",
    "links": [
      {
        "label": "Add a payment method",
        "url": "https://app.writavo.com/billing"
      }
    ]
  },
  {
    "code": "NOT_FOUND",
    "http": "404",
    "meaning": "No such object, or it belongs to another Site. Deliberately indistinguishable.",
    "action": "Either there is no such object, or it belongs to a different Site. If you are certain the id is right, check you are using the key for the correct Site.",
    "links": []
  },
  {
    "code": "SLUG_CONFLICT",
    "http": "409",
    "meaning": "Another object on this Site already uses that slug.",
    "action": "Another object on this Site already uses that slug. Pick a different one, or let the API derive one by omitting `slug`.",
    "links": []
  },
  {
    "code": "IDEMPOTENCY_KEY_CONFLICT",
    "http": "409",
    "meaning": "The key was reused with a different request body.",
    "action": "You reused a key with a different body. That is a bug in the client rather than a retry: generate one key per logical operation and reuse it only to repeat that same operation.",
    "links": []
  },
  {
    "code": "IDEMPOTENCY_KEY_IN_FLIGHT",
    "http": "409",
    "meaning": "The first request with this key is still running. Retry shortly.",
    "action": "The first request with this key is still running. Wait a moment and retry with the same key; you will get the original response replayed.",
    "links": []
  },
  {
    "code": "CONFLICT",
    "http": "409",
    "meaning": "The request clashes with the object's current state, or the object changed under you mid request. The message names the step to take.",
    "action": "The request clashes with the object's current state. Read `error.message` first: when it names the step to take (for example \"This article is live. Unpublish it first.\" or \"Remove the current custom domain first.\"), do that step, then retry. When it says a scan is already running, wait a few minutes and read the result instead of starting another. Otherwise the object changed mid request: re-read it and retry.",
    "links": []
  },
  {
    "code": "PREREQUISITE_MISSING",
    "http": "409",
    "meaning": "Something this operation needs is not set up yet. The message names it and the operation that sets it up. Nothing was done and nothing was charged.",
    "action": "Set up the thing the message names, with the operation it names (for example `PATCH /site/settings` for a primary domain, `POST /seo/competitors` for a competitor, `POST /delivery/proxy` for the reverse proxy), then retry. Nothing was done and nothing was charged. If the missing piece is one only a person can set up (a CMS or Bing connection), give them the link from `POST /delivery/cms` or `POST /seo/backlinks/bing`.",
    "links": [
      {
        "label": "Settings and administration",
        "url": "https://writavo.com/docs/administration"
      }
    ]
  },
  {
    "code": "FEATURE_UNAVAILABLE",
    "http": "409",
    "meaning": "Writavo has this capability switched off right now: paid backlink data platform wide, or spending while the plan has no daily spend cap configured. Nothing the caller sends changes it.",
    "action": "Writavo has this capability switched off right now, and retrying will not help. When the message says \"Spending is paused\", the organisation's plan has no daily spend cap configured, so nothing that spends credits or money can run: report it to the person, who contacts https://writavo.com/support. Otherwise use the free alternative the message names: for backlinks, the Search Console CSV import (`POST /seo/backlinks/import`) or the Bing Webmaster Tools feed (`POST /seo/backlinks/bing`).",
    "links": [
      {
        "label": "Free backlink sources",
        "url": "https://writavo.com/docs/administration#seo"
      }
    ]
  },
  {
    "code": "PRECONDITION_FAILED",
    "http": "412",
    "meaning": "Your If-Match did not match. Someone else edited it. Re-read and retry.",
    "action": "Your `If-Match` did not match, so someone edited the object since you read it. Nothing was written. Re-read, merge your change on top, and retry with the new `ETag`.",
    "links": []
  },
  {
    "code": "VALIDATION_FAILED",
    "http": "422",
    "meaning": "The request parsed but the values are not acceptable. See fields.",
    "action": "Read `error.fields`. It maps each offending field to a message you can show next to the input. The three most common causes are publishing without a title, slug or content; scheduling in the past; and sending `status`, which is read only.",
    "links": [
      {
        "label": "The content lifecycle",
        "url": "https://writavo.com/docs/content-lifecycle"
      }
    ]
  },
  {
    "code": "RATE_LIMIT_EXCEEDED",
    "http": "429",
    "meaning": "Too many requests. Back off and honour Retry-After.",
    "action": "Back off and honour `Retry-After`. Watch `RateLimit-Remaining` on successful responses so you can slow down before you are refused rather than after.",
    "links": [
      {
        "label": "The rate limit classes",
        "url": "https://writavo.com/docs/rate-limits"
      }
    ]
  },
  {
    "code": "MAINTENANCE",
    "http": "503",
    "meaning": "Writes are paused for maintenance. Retry later.",
    "action": "Writes are paused. Reads usually keep working and your published blog is served from cache, so your site stays up. Retry after the window in `Retry-After`.",
    "links": []
  },
  {
    "code": "INTERNAL_ERROR",
    "http": "500",
    "meaning": "Our fault. Safe to retry an idempotent request.",
    "action": "Ours, not yours. Safe to retry, and safer with the same `Idempotency-Key`, which guarantees you do not create a second object if the first request actually succeeded. Quote the `request_id` if you contact support.",
    "links": []
  }
];

export const ERRORS_BY_CODE: Record<string, ErrorEntry> = Object.fromEntries(
  ERROR_CATALOG.map((entry) => [entry.code, entry]),
);
