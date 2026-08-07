# Docker MCP Catalog submission

Everything a reviewer needs, in the order they will want it.

## Build

This repository is self-contained. It vendors `openapi.yaml` and the generator scripts, so the
build context is the repository itself and nothing else has to be cloned:

```bash
git clone https://github.com/SparkleOfficial/writavo-mcp-server
cd writavo-mcp-server
docker build -t writavo-mcp-server .
```

The build runs `node scripts/gen-mcp-tools.mjs --check` before compiling, so an image cannot be
produced from a checkout whose committed tool surface has drifted from the specification.

## Run

```bash
docker run --rm -i -e WRITAVO_API_KEY=wv_sk_your_key_here writavo-mcp-server
```

`-i` is required: the transport is stdio.

With no key the server still starts and `get_api_docs` still answers, which is the cheapest way to
see the whole tool surface without an account.

## Catalog metadata

| Field | Value |
|---|---|
| Server name | `com.writavo/cms` |
| npm package | `@writavo/mcp-server` |
| Transport | stdio |
| Secrets | `WRITAVO_API_KEY`, optional |
| Network egress | `api.writavo.com` only, plus the presigned storage URL that API returns during an upload |
| Filesystem | Reads a file only when `upload_media` is called with an explicit absolute path |
| Runs as | `node`, not root |

## Security posture

- The API base URL is compiled in from the published specification. The `WRITAVO_API_BASE_URL`
  variable is honoured only for a loopback address, so the key cannot be redirected to another
  host by an environment variable.
- Every emitted string is passed through a redactor that masks anything shaped like a key,
  including a key an API echoed back inside an error message.
- Standard output carries protocol messages only. Console channels are rebound to standard error
  before the server starts.
- Key management and webhook configuration are not exposed as tools at all.
- Publishing, deleting and the one billable operation refuse to act until the user confirms.

Full detail in [SECURITY.md](SECURITY.md).

## Verification

```bash
pnpm install
pnpm mcp:smoke
```

Forty four checks, all offline. They include a real MCP client handshake over stdio asserting that
nothing but protocol messages reaches standard output, the no-key experience, the scope and credit
messages, the confirmation gate, and a leak probe against an API that echoes the key back.
