# Security

## Reporting

Email <security@writavo.com>, or use <https://writavo.com/support>. Please do not open a public
issue for anything that affects a live Site.

## What this package does with your key

`WRITAVO_API_KEY` is read once at startup and sent as an `Authorization: Bearer` header to
`https://api.writavo.com/v1`, and to nothing else.

- The base URL comes from the published OpenAPI specification, compiled into the package. The
  `WRITAVO_API_BASE_URL` environment variable is honoured only for an `http://127.0.0.1` or
  `http://localhost` address, which is what the test harness uses. Any other value is ignored and
  a warning is written to standard error. An override that accepted an arbitrary host would be a
  one line key exfiltration route for anything able to write a config file.
- There is no telemetry, no analytics and no third-party host. The only outbound requests are to
  the API and, during an upload, to the presigned storage URL the API returns. That `PUT` carries
  no authorization header, because the signature in the URL is the credential.
- Every string the server emits, on any channel, passes through a redactor that masks anything
  matching a key. This covers the case where the API itself echoes a key back inside an error
  message, which a client cannot control.
- Standard output is reserved for the protocol. Every console channel is rebound to standard error
  before the server connects, so a dependency that logs at import time cannot corrupt the stream or
  put a line in your client's log.

## What an assistant can and cannot reach

A key resolves to exactly one Site, server side. There is no Site parameter anywhere in the API, so
an assistant cannot reach a Site you did not give it a key for. An object belonging to another Site
returns 404 rather than 403, so nothing discloses that it exists.

Beyond that:

- **Nothing becomes public by accident.** `create_article` always creates a draft. Publishing is a
  separate call, and that call refuses to act until you have confirmed it.
- **Nothing is deleted or spent silently.** Every delete and the one billable tool refuse to act
  without explicit confirmation, and say what the consequence would be first.
- **Key management and webhook configuration are not exposed at all**, whatever scopes the key
  carries. Those stay in the dashboard.

## Hardening the key you hand to an assistant

Create a key for the assistant alone, so you can revoke it without affecting anything else, and
give it only the scopes it needs. A read-only assistant needs `articles:read`, `taxonomy:read`,
`authors:read` and `meta:read`, and nothing more. Leave `pipeline:run` off unless you want the
assistant able to spend credits.

A publishable key (`wv_pub_`) works here too. It can only read published content, so an assistant
holding one cannot see a draft or change anything.
