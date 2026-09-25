# Security

## Reporting

Email <security@writavo.com>, or use <https://writavo.com/support>. Please do not open a public
issue for anything that affects a live Site.

## What this package does with your key

The key comes from `WRITAVO_API_KEY` if it is set, and otherwise from the saved sign-in the
`login` tool writes. Either way it is sent as an `Authorization: Bearer` header to
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

## Browser sign-in

`login` generates the new secret key on this machine and sends only its SHA-256 hash and its
first twelve characters to be approved. The approval page and the polling endpoint never hold a
usable credential, and the secret never crosses the network until it is used as a bearer header.

- The person approving sees the requesting machine's name and a short code, chooses the Site, and
  can deny. The key is limited to that one Site, carries only the scopes asked for (never key or
  webhook management), and expires after 90 days. While the server is in use it asks the API, at
  most once a day, to extend a key within 30 days of expiry; the API extends only keys an agent
  signed in with, only while their creator still holds the permission to manage keys, and never
  past a year from creation.
- On approval the key is saved to `$XDG_CONFIG_HOME/writavo/credentials.json` (else
  `~/.config/writavo/credentials.json`, or `%APPDATA%\writavo\credentials.json` on Windows). The
  directory is created `0700` and the file `0600`, and it is replaced atomically.
- `WRITAVO_API_KEY` always outranks the saved sign-in. A key set deliberately in a client config is
  never silently replaced by a browser login.
- `logout` revokes the key on Writavo (`POST /v1/auth/key/revoke`, authenticated as that key), then
  deletes the file and stops using the key. If the revoke cannot reach Writavo it says so, and the
  key stays valid until it is revoked at <https://app.writavo.com/settings/agents> or expires.
- The hosted server at `https://mcp.writavo.com/mcp` never runs this flow: its clients sign in with
  OAuth 2.1, and the key behind a connection lives only in the encrypted grant on the server.

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
