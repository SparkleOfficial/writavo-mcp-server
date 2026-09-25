---
name: writavo
description: >-
  Manage a Writavo Site's blog content: draft, edit, organise, schedule and publish articles, upload media, manage categories, tags and authors, import an existing blog, and trigger the AI article pipeline. Use when a task involves a blog or content site hosted on Writavo.
license: MIT
metadata:
  homepage: https://writavo.com
  documentation: https://writavo.com/docs
  openapi: https://writavo.com/openapi.json
---

# Writavo

Writavo is a CMS with optional AI article generation. A Site's articles, media, categories,
tags and authors live in Writavo and are served on the customer's own domain. Everything a
person can do to that content in the dashboard, an API key can do.

## When to use this skill

- The user wants an article drafted, edited, scheduled or published on a Writavo Site.
- The user wants content organised: categories, tags, authors, featured images.
- The user is moving an existing blog into Writavo.
- The user wants the AI pipeline to research and write articles for them.

**Do not** use it to write a one-off paragraph (just write it), to administer a WordPress, Ghost
or Webflow site (use that platform's API), or to change billing, team members or roles (those
are dashboard-only by design).

## Step 0: pick a surface

| Surface | When |
|---|---|
| Hosted MCP `https://mcp.writavo.com/mcp` | You are an assistant with MCP. Sign-in is OAuth in the browser; no key to handle. |
| Local MCP `@writavo/mcp-server` | You need to import from a file or upload a local image. Same tools, plus file access. |
| CLI `npx @writavo/cli` | You have a shell. Every command is named after an API operation. |
| REST `https://api.writavo.com/v1` | Anything else. OpenAPI 3.1 at https://writavo.com/openapi.json. |

MCP setup, hosted: `claude mcp add --transport http writavo https://mcp.writavo.com/mcp` (or add the
URL as a custom connector); the client opens the browser for sign-in. Local:
`{"command": "npx", "args": ["-y", "@writavo/mcp-server"]}`, and with no `WRITAVO_API_KEY` set,
call the `login` tool. The exact command or config for every client (Claude Code, Claude,
ChatGPT, Codex, Cursor, VS Code, Gemini CLI, Windsurf, Zed) and a troubleshooting table:
https://writavo.com/docs/mcp.md

Some actions need a person's approval when an AI agent asks: deleting content, unpublishing and
running the pipeline. The tool then returns a link instead of acting. Give the user the link, wait
for them to approve, and call the same tool again with the same arguments plus the `approval_id`
it gave you. It works once and lapses after 24 hours. If they deny it, stop and ask what they want
instead.

## Step 1: get a credential

- **The user has a key:** use it. `wv_sk_` keys are secret; never echo one back or commit it.
- **They do not:** on the hosted MCP server there is nothing to do: the sign-in already happened in
  the browser. On the local server, run the device sign-in: `login`, then `login_status`.
  Over REST it is `POST /auth/device` then polling `POST /auth/device/token`. The user approves
  in their browser and chooses the Site. Details: https://writavo.com/auth.md

Then call `get_site_info` and `verify_api_key` (`GET /ping`, which returns the scopes the key
carries) and tell the user which Site you are connected to and what you may do there. If the task
needs a permission the connection lacks, say so rather than trying and failing.

## Step 2: the content loop

1. **Look before writing.** `list_articles` (filter by `status`, `category_id`, `tag_id`, `slug`) and
   `get_site_info`. Reuse existing categories, tags and authors: `list_categories`, `list_tags`,
   `list_authors`.
2. **Create a draft.** `create_article` always creates `status: draft`. A draft is private: not
   on the blog, not in the sitemap, and the pipeline never touches it.
3. **Edit.** `update_article`. Send `If-Match` with the `ETag` from your last read, so you do
   not overwrite a person's concurrent edit. A `412` means re-read and try again.
4. **Images.** `upload_media` (two steps over REST: `POST /media/upload-url`, then register).
5. **Publish only when asked.** `publish_article` makes it public at once;
   `schedule_article` publishes later. Both are separate, explicit calls on purpose. If the user
   did not say "publish", leave it as a draft and tell them where it is.

## Moving a blog in

Follow the runbook at https://writavo.com/docs/migrate.md, or the `migrate-content` prompt: read the source
only, copy text verbatim, keep every slug and original publish date and never guess one, dry run
before importing. Use `import_content`, or over REST set `external_id` to the old system's id on every article and
look it up with `GET /articles?external_id=` before writing, so a second run updates instead of
duplicating. Keep the old `slug` so URLs do not change, and pass the original `published_at` on
the first publish so feed order and sitemap dates survive. Guide: https://writavo.com/docs/migrate

## The AI pipeline: costs money

`trigger_pipeline_run` (`POST /pipeline/runs`) is the only billable operation. **Confirm with the
user before calling it**, and pass `max_articles` as a ceiling. It needs the `pipeline:run`
scope. A `402` names which limit was met: `NOT_ENTITLED` (plan), `INSUFFICIENT_CREDITS`,
`SPEND_CAP_REACHED` or `PAYMENT_METHOD_REQUIRED`. Report it; do not retry. Watch progress with
`get_pipeline_status` and `get_pipeline_queue`.

## Errors

Always `{"ok": false, "error": {"code", "message"}}`. Branch on `code`, never on `message`.

- `401`: no key or a bad one. Re-run the sign-in.
- `403 INSUFFICIENT_SCOPE`: the key lacks the scope. Ask for a key that has it.
- `404`: not found, or on another Site. The API never says which.
- `422 VALIDATION_FAILED`: `error.fields` names each bad field.
- `429`: wait `Retry-After` seconds.
- `403 AGENT_ACCESS_DISABLED`: the organisation turned AI agent access off. Tell the user; do not retry.
- `428 APPROVAL_REQUIRED`: give the user the approval link (see Step 0).

Every code and its fix: https://writavo.com/docs/errors

## Do not

- **Do not publish without being asked.** Drafts are the safe default; leave work there.
- **Do not set pipeline statuses** with `update_article`. Ten of the thirteen statuses belong to
  the engine and a PATCH to one is refused.
- **Do not trigger a pipeline run without confirmation.** It spends the user's credits.
- **Do not pass a site or tenant id.** The Site comes from the key; there is no such parameter.
- **Do not paste a secret key into a file, a commit or a chat reply.**

## Reference

- https://writavo.com/llms.txt: what Writavo is for, and when not to use it
- https://writavo.com/openapi.json: every operation, typed
- https://writavo.com/docs/mcp.md: setting up the MCP server in any client, and troubleshooting
- https://writavo.com/docs/migrate.md: moving an existing blog in
- https://writavo.com/mcp/docs: documentation over MCP (Streamable HTTP, no key)
