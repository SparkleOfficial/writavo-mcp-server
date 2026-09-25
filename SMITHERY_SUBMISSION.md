# Smithery submission

## Listing

| Field | Value |
|---|---|
| Package | `@writavo/mcp-server` 0.3.0 |
| Qualified name | `com.writavo/cms` |
| Remote | `https://mcp.writavo.com/mcp`, Streamable HTTP, OAuth 2.1 (dynamic client registration, PKCE S256). No config: the person signs in in the browser |
| Local transport | stdio, launched with `npx -y @writavo/mcp-server` |
| Local config | one optional field, `writavoApiKey`, mapped to `WRITAVO_API_KEY` |
| Homepage | <https://writavo.com/docs/mcp> |

List the remote URL first. Smithery can point at a hosted Streamable HTTP server directly, and
that is the path with nothing to install and no key to paste. The stdio manifest
[smithery.yaml](smithery.yaml) stays for people who want the server on their own machine (it adds
importing and uploading from local files).

**Status: prepared, not submitted.** Submitting waits for `mcp.writavo.com` to be deployed and
`@writavo/mcp-server@0.3.0` to be published.

## Description

Your content management system, inside an AI assistant. Draft a post, set its category and byline,
attach an image, schedule it, publish it, all from a conversation. Tools covering articles,
categories, tags, authors, media and the AI generation pipeline, compiled from Writavo's published
OpenAPI specification rather than written by hand. The hosted server and the npm package mount the
same tool code.

## Signing in

Remote: the client registers itself, the person signs in to Writavo in the browser, picks the Site
and ticks what the assistant may do (running the paid AI pipeline is off unless they tick it). The
grant is an ordinary Writavo key they can see and revoke under Settings > AI agents.

Local: `login` runs the same browser approval; or set `WRITAVO_API_KEY`.

## Why the key is optional (local)

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
- Deletes, unpublishing and pipeline runs from an AI agent can require a person's approval in the
  dashboard (on by default). The tool returns a link; nothing happens until someone approves.
- An owner or admin can turn AI agent access off for the whole organisation, and every agent call
  is logged where the customer can read it.
- Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint: false`).
- The key is sent to `api.writavo.com` and nowhere else, and is masked out of every reply and log
  line. See [SECURITY.md](SECURITY.md).
