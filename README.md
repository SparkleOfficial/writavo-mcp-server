# @writavo/mcp-server

Your Writavo Site's content, inside an AI assistant. Sign in from the browser, bring an existing
blog across, draft a post, set its category and byline, attach an image, schedule it, publish it,
all from a conversation.

It speaks the Model Context Protocol over stdio, so it runs as a subprocess of your client rather
than as a service you host.

## Get started

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
you chose, never carries key or webhook management, expires after 90 days, and is saved to
`~/.config/writavo/credentials.json` (`$XDG_CONFIG_HOME` is honoured; `%APPDATA%\writavo` on
Windows) with owner-only permissions. `logout` deletes it; revoke the key itself at
<https://app.writavo.com/settings/api-keys>.

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

Thirty six tools are compiled from Writavo's published OpenAPI specification, plus seven written
by hand:

- **Articles.** List, read, create, update, delete, publish, unpublish, schedule, cancel a schedule.
- **Taxonomy and people.** Categories, tags and authors: list, read, create, update, delete.
- **Media.** List, read, update, delete, and `upload_media`, which drives the whole three step
  presigned upload in one call so the assistant does not have to orchestrate it.
- **Pipeline.** Trigger a run, read its status, read the queue.
- **Meta.** Site information, content types, plan usage and balances, and `get_api_docs`, which
  needs no key at all.
- **Sign-in.** `login`, `login_status` and `logout`, described above.
- **Plans.** `start_plan_purchase` returns the billing link with a plan preselected. Payment
  happens on Stripe's page in your browser, never in the chat. The CMS (storing, publishing and
  importing content) is pay-as-you-go and needs no plan; a plan buys the AI article pipeline.
- **Import.** `import_content` brings an existing blog in from a file (below).

## Importing a blog

The `migrate-content` prompt walks an assistant through the whole move: sign in, inspect your
current system with the access you already have, write an import file, dry run, fix, import, and
verify. Slugs are kept so URLs do not change, published posts keep their original publication
dates, drafts stay drafts, and images are copied into your media library.

The file is the **Writavo Import Format v1**, a single JSON document:

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
copy and a time estimate, and writes nothing. An import that publishes needs `confirm: true`. It
runs one batch per call, saves its progress next to the file (`<file>.writavo-progress.json`),
and is safe to run again: a finished import changes nothing. It never deletes or unpublishes
anything, and it changes nothing in your content except the URLs of the images it copied.

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

## What it never writes down

- Your key is sent to `https://api.writavo.com/v1` as a bearer header and to nothing else. No
  telemetry, no analytics, no third-party host. The base URL is read from the specification and
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
| `INSUFFICIENT_SCOPE` | The key lacks the scope, or its creator's permissions no longer cover it | Add the scope at <https://app.writavo.com/settings/api-keys> |
| `NOT_ENTITLED` | Your plan does not include the capability | Upgrade at <https://app.writavo.com/billing> |
| `INSUFFICIENT_CREDITS` | The organisation cannot afford the next unit of work | Top up at <https://app.writavo.com/billing> |
| `SPEND_CAP_REACHED` | This Site hit the monthly ceiling you set for it | Raise the cap or wait for the reset |
| `NOT_FOUND` | No such object, or it belongs to a different Site | Check you are using the key for the right Site |

The full catalog is in `get_api_docs` under `errors`, and at <https://writavo.com/docs/errors>.

## Prompts

- **draft-article.** Research a topic and write a draft in your Site's own voice. It never
  publishes or schedules.
- **publish-checklist.** Walk an existing draft through title, slug, SEO fields, excerpt, category,
  author and featured image, then ask before publishing.
- **migrate-content.** Move an existing blog from another system into your Site, faithfully,
  with a dry run and your confirmation before anything is published.

## Development

This package lives in the Writavo monorepo. Its tool schemas, descriptions and reference text are
generated, not written:

```
npm run gen         regenerate from the vendored openapi.yaml
npm test            run the offline smoke checks (sign-in, import and more, against a stub)
npm run gen:check   fails if the committed tool surface is stale
```

Adding an endpoint to `openapi.yaml` and regenerating is the whole of adding a tool. Editing
anything under `src/generated/` fails CI. The seven hand-written tools live in `src/tools/` and are
listed in `LOCAL_TOOLS` in the monorepo's `scripts/mcp-surface.mjs`.

## Licence

**MIT** ([LICENSE](LICENSE)). Fork it, modify it, vendor it, ship it inside something else.

The MIT grant covers **this client package only**. It is not a licence to the Writavo Content API
that the package calls, or to any other part of Writavo. Using the API still requires your own
credentials and is governed by the terms at <https://writavo.com/terms>, and `openapi.yaml` (the
specification this package is compiled from) remains the proprietary contract it always was.

That split is deliberate. This package is a thin, generated client: there is nothing in it worth
restricting, and an MIT client is easier to trust, audit, package and list in a registry. The
product is the API behind it.
