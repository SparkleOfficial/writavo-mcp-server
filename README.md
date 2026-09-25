# @writavo/mcp-server

Your Writavo Site's content, inside an AI assistant. Sign in from the browser, bring an existing
blog across, draft a post, set its category and byline, attach an image, schedule it, publish it,
all from a conversation.

There are two ways to run it, with the same tools in both:

- **Hosted** at `https://mcp.writavo.com/mcp` (Streamable HTTP, OAuth 2.1). Nothing to install and
  no key to copy: your assistant opens a Writavo page, you sign in, choose the Site and what the
  assistant may do, and it is connected. Works from Claude Code, Claude.ai, ChatGPT, Cursor, VS Code
  and any client that speaks remote MCP.
- **Local**, this npm package over stdio, as a subprocess of your client. It adds reading import
  files and images from your own disk.

**Full setup guide, for people and for AI assistants:** <https://writavo.com/docs/mcp> (markdown:
<https://writavo.com/docs/mcp.md>). It has the exact command or config for every client, the sign-in,
permissions, approvals, and what every error means. Moving a blog in:
<https://writavo.com/docs/migrate>.

> **If you are an AI assistant asked to install Writavo:** use the hosted server unless the task
> needs files on this machine; add it with your client's command below; the person then signs in
> through the browser (nothing to paste); then call `get_site_info` and `verify_api_key` and tell
> them which Site you are connected to and what you may do there.

## Connect the hosted server (recommended)

**Claude Code:**

```bash
claude mcp add --transport http writavo https://mcp.writavo.com/mcp
```

Then run `/mcp` in Claude Code and choose Writavo to sign in. Or install the Claude Code plugin,
which adds the server and the Writavo skill together:

```bash
claude plugin marketplace add SparkleOfficial/writavo-mcp-server
claude plugin install writavo@writavo
```

**Cursor:** [Add Writavo to Cursor](https://cursor.com/en/install-mcp?name=writavo&config=eyJ1cmwiOiJodHRwczovL21jcC53cml0YXZvLmNvbS9tY3AifQ==)
(or `cursor://anysphere.cursor-deeplink/mcp/install?name=writavo&config=eyJ1cmwiOiJodHRwczovL21jcC53cml0YXZvLmNvbS9tY3AifQ==`).

**VS Code:** [Add Writavo to VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=writavo&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.writavo.com%2Fmcp%22%7D)
(or `vscode:mcp/install?%7B%22name%22%3A%22writavo%22%2C%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.writavo.com%2Fmcp%22%7D`).

**Claude (claude.ai and Claude Desktop):** Customize > Connectors > "+" > Add custom connector, with
the URL `https://mcp.writavo.com/mcp`, then Connect.

**ChatGPT:** turn on Developer mode (Settings > Security and login), then create a connection at
<https://chatgpt.com/plugins> with the URL `https://mcp.writavo.com/mcp` and OAuth.

**Codex CLI:** `codex mcp add writavo --url https://mcp.writavo.com/mcp` (it starts the sign-in;
`codex mcp login writavo` repeats it).

**Gemini CLI:** `gemini mcp add --transport http -s user writavo https://mcp.writavo.com/mcp`, then
`/mcp auth writavo`.

**Windsurf and Zed:** see <https://writavo.com/docs/mcp#clients>.

**Any other client** that takes a JSON config:

```json
{
  "mcpServers": {
    "writavo": { "type": "http", "url": "https://mcp.writavo.com/mcp" }
  }
}
```

When you connect, Writavo shows which assistant is asking and where it will send you back, the
Site to connect, and what it may do: for articles, for categories, tags and authors, for media and
for the AI pipeline, you choose No access, Read, or Read and write ("Read and run" for the
pipeline, which spends credits). The choices start from your organisation's default, which is Read
and write for content and media and Read for the pipeline. The connection is an ordinary Writavo
key limited to that Site and those permissions, named after the app ("Claude Code (hosted MCP)").
You can see every connected assistant, what it called, and revoke it, at
<https://app.writavo.com/settings/agents>.

## Or run it locally

Add the server to your MCP client. No key is needed to start:

```json
{
  "mcpServers": {
    "writavo": {
      "command": "npx",
      "args": ["-y", "@writavo/mcp-server"]
    }
  }
}
```

Then ask the assistant to sign you in to Writavo. It calls `login`, which gives you a link and a
short code. Open the link, sign in (or create an account and finish onboarding; choose "Bring my
existing articles" if you are moving a blog), pick the Site, and approve. The assistant picks the
key up by itself, with no restart and nothing to copy.

The key is made on your machine and only its hash is sent for approval. It is limited to the Site
you chose, never carries key or webhook management, expires after 90 days unless it is in use (the
server extends it while you keep using it, up to a year from sign-in), and is saved to
`~/.config/writavo/credentials.json` (`$XDG_CONFIG_HOME` is honoured; `%APPDATA%\writavo` on
Windows) with owner-only permissions. `logout` revokes the key on Writavo and deletes the file.

### Or use a key you created

```json
{
  "mcpServers": {
    "writavo": {
      "command": "npx",
      "args": ["-y", "@writavo/mcp-server"],
      "env": { "WRITAVO_API_KEY": "wv_sk_your_key_here" }
    }
  }
}
```

Create the key at <https://app.writavo.com/settings/api-keys> and give it only the scopes you want
the assistant to have. `WRITAVO_API_KEY` always takes precedence over a browser sign-in. A key
never outranks the person who made it: narrowing your own permissions narrows every key you
created, on the next request.

Without a key the server still starts, and `login`, `get_api_docs` and the import format
description all work, so you can read the whole API reference before signing up.

## What it can do

Thirty six tools are compiled from Writavo's published OpenAPI specification, plus four written by
hand on both servers and three more (`login`, `login_status`, `logout`) on the local one:

- **Articles.** List, read, create, update, delete, publish, unpublish, schedule, cancel a schedule.
- **Taxonomy and people.** Categories, tags and authors: list, read, create, update, delete.
- **Media.** List, read, update, delete, and `upload_media`, which drives the whole three step
  presigned upload in one call so the assistant does not have to orchestrate it. It takes a public
  `url` or the bytes as `base64` with a `filename`; the local server also takes a `path`.
- **Pipeline.** Trigger a run, read its status, read the queue.
- **Meta.** Site information, content types, plan usage and balances, and `get_api_docs`, which
  needs no key at all.
- **Sign-in (local only).** `login`, `login_status` and `logout`, described above. The hosted
  server signs in with OAuth when you connect it.
- **Plans.** `start_plan_purchase` returns the billing link with a plan preselected. Payment
  happens on Stripe's page in your browser, never in the chat. The CMS (storing, publishing and
  importing content) is pay-as-you-go and needs no plan; a plan buys the AI article pipeline.
- **Import.** `import_content` brings an existing blog in (below).

Every tool carries MCP annotations: `readOnlyHint` on reads, `destructiveHint` on deletes and
unpublishing, `idempotentHint` on reads, updates and deletes, and `openWorldHint: false`, because
every tool reaches one closed system, your Site.

## Importing a blog

The `migrate-content` prompt walks an assistant through the whole move: sign in, inspect your
current system with the access you already have, write an import file, dry run, fix, import, and
verify. Slugs are kept so URLs do not change, published posts keep their original publication
dates, drafts stay drafts, and images are copied into your media library.

The document is the **Writavo Import Format v1**, a single JSON document. Pass it inline as `data`
(up to 50 articles and 2 MB per call, which works on the hosted server), or, on the local server,
as the absolute `path` of a file of any size:

```json
{
  "format": "writavo-import",
  "version": 1,
  "authors": [{ "ref": "jane", "name": "Jane Doe", "is_ai_generated": false }],
  "categories": [{ "slug": "guides", "name": "Guides" }],
  "tags": [{ "slug": "soil", "name": "Soil" }],
  "articles": [
    {
      "external_id": "blog:1001",
      "status": "published",
      "title": "How to test your soil",
      "slug": "how-to-test-your-soil",
      "content": "Markdown, with ![images](https://example.com/kit.jpg)",
      "author": "jane",
      "category": "guides",
      "tags": ["soil"],
      "published_at": "2021-03-04T09:30:00Z"
    }
  ]
}
```

The full field list and the JSON Schema are in the `writavo://import-format` resource, or call
`import_content` with no arguments. `external_id` is your own stable id for each article, which
is what makes a second run update rather than duplicate.

`import_content` is a dry run unless told otherwise: it checks every article against the Site and
reports what it would create, update and publish, every problem by `external_id`, the images to
copy and a time estimate, and writes nothing. An import that publishes needs `confirm: true`. From
a file it runs one batch per call, saves its progress next to the file
(`<file>.writavo-progress.json`), and is safe to run again: a finished import changes nothing.
Inline, a call that runs out of time lists the articles still to do, and sending an article again
updates it rather than duplicating it. It never deletes or unpublishes anything, and it changes
nothing in your content except the URLs of the images it copied.

## What it will not do without asking

`publish_article`, `schedule_article`, every `delete_*`, `trigger_pipeline_run` and an
`import_content` that publishes do nothing on the first call. They describe what would happen and
wait for `confirm: true`, which the assistant can only set after you have agreed. Publishing puts
content on your live site, deleting is permanent, and a pipeline run spends real credits.

Two things are not reachable from an assistant at all, whatever scopes the key carries:

- **API keys.** A server that can mint a secret key is a server whose compromise mints secret keys,
  and the key it would use to do so is in a config file on the same machine.
- **Webhooks.** An assistant that can repoint delivery URLs can quietly redirect your event stream.

Both stay in the dashboard.

### Approvals, and turning agents off

When an assistant signed in through the browser (either server) deletes something, unpublishes an
article or starts a pipeline run, your organisation can require a person to approve it first. This
is on by default. The tool then does nothing and returns a link to
`https://app.writavo.com/approvals/...`; once you approve there, the assistant repeats the call
with the approval id and it goes through, once, for exactly that request. An owner or admin can
switch approvals off, or switch AI agent access off for the whole organisation, at
<https://app.writavo.com/settings/agents>, which also lists every connected assistant and every
call they made. Keys you create yourself in the dashboard are not subject to either switch.

## What it never writes down

- Your key is sent to `https://api.writavo.com/v1` as a bearer header and to nothing else. No
  telemetry, no analytics, no third-party host. Each request names the tool that made it
  (`Writavo-Mcp-Tool`), which is what fills the call log in Settings > AI agents. The base URL is read from the specification and
  cannot be repointed off `api.writavo.com` by an environment variable. The only other requests
  are the presigned storage upload during `upload_media` or an import, and, during an import, the
  image URLs in your own file, fetched to copy them.
- Every reply, log line and error is passed through a redactor, so a key cannot reach your
  transcript even if the API echoed it back inside an error message.
- Standard output carries protocol messages and nothing else. Every console channel is rebound to
  standard error before the server starts, because one stray line on stdout is a dropped
  connection.

## Errors you might see

Each one is answered with what to change rather than a status code.

| Code | What it means | What to do |
|---|---|---|
| `INSUFFICIENT_SCOPE` | The key lacks the scope, or its creator's permissions no longer cover it | Connect again with that permission (a sign-in), or add the scope to a key you created at <https://app.writavo.com/settings/api-keys> |
| `NOT_ENTITLED` | Your plan does not include the capability | Upgrade at <https://app.writavo.com/billing> |
| `INSUFFICIENT_CREDITS` | The organisation cannot afford the next unit of work | Top up at <https://app.writavo.com/billing> |
| `SPEND_CAP_REACHED` | This Site hit the monthly ceiling you set for it | Raise the cap or wait for the reset |
| `NOT_FOUND` | No such object, or it belongs to a different Site | Check you are using the key for the right Site |
| `AGENT_ACCESS_DISABLED` | AI agent access is off for the organisation | An owner or admin turns it on at <https://app.writavo.com/settings/agents> |
| `APPROVAL_REQUIRED` | A person must approve this action | Give them the link, wait, then call the tool again with `approval_id` |
| `APPROVAL_PENDING` | Nobody has decided yet | Ask them to open the link; call again once approved |
| `APPROVAL_DENIED` | A person denied the approval | Nothing to retry; decide what to do instead |
| `APPROVAL_INVALID` | The approval expired, was used, or was for a different request | Call the tool again without `approval_id` |
| `API_KEY_REVOKED` / `API_KEY_EXPIRED` | The connection's key was revoked or expired | Sign in again |
| `PAYMENT_METHOD_REQUIRED` | The included CMS allowance is used up and no card is on file | Add a card at <https://app.writavo.com/billing>; not a plan limit |

The full catalog is in `get_api_docs` under `errors`, and at <https://writavo.com/docs/errors>.
Sign-in problems (a browser page saying the sign-in "could not be confirmed in this browser", no Site
to choose, and so on) are covered at <https://writavo.com/docs/mcp#troubleshooting>.

## Prompts

- **draft-article.** Research a topic and write a draft in your Site's own voice. It never
  publishes or schedules.
- **publish-checklist.** Walk an existing draft through title, slug, SEO fields, excerpt, category,
  author and featured image, then ask before publishing.
- **migrate-content.** Move an existing blog from another system into your Site, faithfully,
  with a dry run and your confirmation before anything is published. It follows the runbook at
  <https://writavo.com/docs/migrate>.

## Development

This package lives in the Writavo monorepo. The tools live once, in `src/core/`, exported as
`@writavo/mcp-server/core`:

```ts
import { createWritavoMcpServer } from "@writavo/mcp-server/core";

const server = createWritavoMcpServer({
  apiKey: () => key,              // null makes every key-requiring tool say how to connect
  userAgent: "my-host/1.0",
  host: "remote",                 // or "stdio"
});
```

Nothing reachable from that entry reads the environment, touches a filesystem or keeps a key in
module state, so it runs in a Cloudflare Worker (the hosted server mounts exactly this) as well as
in Node. The stdio entry (`src/index.ts`) is the core plus the local extras. Tool schemas,
descriptions and reference text are generated, not written:

```
npm run gen         regenerate from the vendored openapi.yaml
npm test            run the offline smoke checks (sign-in, import and more, against a stub)
npm run gen:check   fails if the committed tool surface is stale
```

Adding an endpoint to `openapi.yaml` and regenerating is the whole of adding a tool; an operation
marked `x-writavo-approval` gains an `approval_id` argument by itself. Editing anything under
`src/generated/` fails CI. The seven hand-written tools live in `src/tools/` and are listed in
`LOCAL_TOOLS` in the monorepo's `scripts/mcp-surface.mjs`.

## Licence

**MIT** ([LICENSE](LICENSE)). Fork it, modify it, vendor it, ship it inside something else.

The MIT grant covers **this client package only**. It is not a licence to the Writavo Content API
that the package calls, or to any other part of Writavo. Using the API still requires your own
credentials and is governed by the terms at <https://writavo.com/terms>, and `openapi.yaml` (the
specification this package is compiled from) remains the proprietary contract it always was.

That split is deliberate. This package is a thin, generated client: there is nothing in it worth
restricting, and an MIT client is easier to trust, audit, package and list in a registry. The
product is the API behind it.
