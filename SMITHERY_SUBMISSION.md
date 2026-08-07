# Smithery submission

## Listing

| Field | Value |
|---|---|
| Package | `@writavo/mcp-server` |
| Qualified name | `com.writavo/cms` |
| Transport | stdio, launched with `npx -y @writavo/mcp-server` |
| Config | one optional field, `writavoApiKey`, mapped to `WRITAVO_API_KEY` |
| Homepage | <https://writavo.com/docs/mcp> |

The manifest is [smithery.yaml](smithery.yaml).

## Description

Your content management system, inside an AI assistant. Draft a post, set its category and byline,
attach an image, schedule it, publish it, all from a conversation. Thirty eight tools covering
articles, categories, tags, authors, media and the AI generation pipeline, compiled from Writavo's
published OpenAPI specification rather than written by hand.

## Why the key is optional

The server starts without one and `get_api_docs` still answers the whole API reference, so someone
evaluating the listing can read exactly what the tools do before creating an account. Every tool
that needs a key returns a message naming the two links required to get one rather than an
authentication error.

## Safety notes for reviewers

- A key resolves to exactly one Site server side. There is no Site parameter in the API, so the
  assistant cannot reach anything the key was not issued for.
- `create_article` always creates a draft. Nothing becomes public without a separate publish call,
  and that call does nothing until the user confirms it. The same applies to every delete and to
  the single billable operation.
- Key management and webhook configuration are deliberately not exposed as tools.
- The key is sent to `api.writavo.com` and nowhere else, and is masked out of every reply and log
  line. See [SECURITY.md](SECURITY.md).
