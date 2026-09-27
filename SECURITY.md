# Security

## Reporting

Email <security@writavo.com>, or use <https://writavo.com/support>. Please do not open a public
issue for anything that affects a live Site.

## How Writavo is reached over MCP

Writavo is used over MCP through one server: the hosted one at `https://mcp.writavo.com/mcp`
(Streamable HTTP). There is no package to install and no key file on your machine. The tools in
this repository run inside that server.

## Browser sign-in

Your assistant signs in with OAuth 2.1 (dynamic client registration or a client ID metadata
document, PKCE S256 only, refresh tokens).

- The server generates the Writavo secret key for the connection itself and keeps it only in the
  encrypted grant on the server. The assistant receives OAuth tokens that work at
  `mcp.writavo.com` (an access token lasts one hour), never the key.
- The person approving sees which assistant is asking and where it will send them back, chooses
  the Site and what the assistant may do, and can deny. The key is limited to that one Site and
  never carries key or webhook management.
- A sign-in must be started and approved in the same browser. A sign-in link someone else started
  cannot connect their assistant to your Site: it is cancelled, and any key it produced is revoked.
- The key expires after 90 days and is extended while the connection is in use, only while the
  person who approved it can still manage API keys on the Site, and never past a year from
  creation.
- Revoking the connection at <https://app.writavo.com/settings/agents> (or under API keys) ends it
  on its next call or refresh.

A client that cannot do OAuth may send a Writavo secret key (`wv_sk_`) as the bearer token
instead. Publishable keys (`wv_pub_`) are refused. The API validates the key on the first call.

## What the tools do with the key

- It is sent as an `Authorization: Bearer` header to `https://api.writavo.com/v1`, and to nothing
  else. The base URL comes from the published OpenAPI specification, compiled into the tools.
- There is no telemetry, no analytics and no third-party host. The only other outbound requests
  are, during an upload, the presigned storage URL the API returns (that `PUT` carries no
  authorization header, because the signature in the URL is the credential) and, during an import,
  the https image URLs in your own document, fetched to copy them.
- Every string the server emits passes through a redactor that masks anything matching a key. This
  covers the case where the API itself echoes a key back inside an error message.

## What an assistant can and cannot reach

A key resolves to exactly one Site, server side. There is no Site parameter anywhere in the API, so
an assistant cannot reach a Site you did not connect it to. An object belonging to another Site
returns 404 rather than 403, so nothing discloses that it exists.

Beyond that:

- **Nothing becomes public by accident.** `create_article` always creates a draft. Publishing is a
  separate call, and that call refuses to act until you have confirmed it.
- **Nothing is deleted or spent silently.** Every delete and every tool or action that spends
  money refuses to act without explicit confirmation, and says what the consequence would be first.
- **Approvals.** Actions that spend money, change the team or change the live site need a person's
  approval in the dashboard when an assistant asks, and deleting or unpublishing content does too
  while the organisation requires it.
- **Key management and webhook configuration are not exposed at all**, whatever permissions the
  connection carries. Those stay in the dashboard.

## Choosing what to grant

On the sign-in page, give the assistant only the areas it needs. A read-only assistant needs Read
on articles, categories, tags and authors, and nothing more. Leave the AI pipeline at Read unless
you want the assistant able to spend credits.
