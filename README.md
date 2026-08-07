# @writavo/mcp-server

Your Writavo Site's content, inside an AI assistant. Draft a post, set its category and byline,
attach an image, schedule it, publish it, all from a conversation.

It speaks the Model Context Protocol over stdio, so it runs as a subprocess of your client rather
than as a service you host.

## Install

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
the assistant to have. A key never outranks the person who made it: narrowing your own permissions
narrows every key you created, on the next request.

Without a key the server still starts and `get_api_docs` still works, so you can read the whole
API reference before signing up.

## What it can do

Thirty six tools are compiled from Writavo's published OpenAPI specification, plus two written by
hand:

- **Articles.** List, read, create, update, delete, publish, unpublish, schedule, cancel a schedule.
- **Taxonomy and people.** Categories, tags and authors: list, read, create, update, delete.
- **Media.** List, read, update, delete, and `upload_media`, which drives the whole three step
  presigned upload in one call so the assistant does not have to orchestrate it.
- **Pipeline.** Trigger a run, read its status, read the queue.
- **Meta.** Site information, content types, plan usage and balances, and `get_api_docs`, which
  needs no key at all.

## What it will not do without asking

`publish_article`, `schedule_article`, every `delete_*` and `trigger_pipeline_run` do nothing on
the first call. They describe what would happen and wait for `confirm: true`, which the assistant
can only set after you have agreed. Publishing puts content on your live site, deleting is
permanent, and a pipeline run spends real credits.

Two things are not reachable from an assistant at all, whatever scopes the key carries:

- **API keys.** A server that can mint a secret key is a server whose compromise mints secret keys,
  and the key it would use to do so is in a config file on the same machine.
- **Webhooks.** An assistant that can repoint delivery URLs can quietly redirect your event stream.

Both stay in the dashboard.

## What it never writes down

- Your key is sent to `https://api.writavo.com/v1` as a bearer header and to nothing else. No
  telemetry, no analytics, no third-party host. The base URL is read from the specification and
  cannot be repointed off `api.writavo.com` by an environment variable.
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

## Development

This package lives in the Writavo monorepo. Its tool schemas, descriptions and reference text are
generated, not written:

```
pnpm mcp:gen        regenerate from openapi.yaml
pnpm mcp:smoke      build, then run the offline smoke test
pnpm docs:check     rule 12 fails if the committed tool surface is stale
```

Adding an endpoint to `openapi.yaml` and regenerating is the whole of adding a tool. Editing
anything under `src/generated/` fails CI.

## Licence

Proprietary. See LICENSE.
