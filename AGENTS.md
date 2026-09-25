# AGENTS.md

Instructions for AI coding agents working in this repository, and for agents that want to use
Writavo from inside another project.

## What this repository is

`@writavo/mcp-server`: the MCP tools for the Writavo Content API (`https://api.writavo.com/v1`).
Its tools are **generated** from the OpenAPI specification, so the server cannot expose an
operation the API does not have.

The tools live once, in `src/core/` (exported as `@writavo/mcp-server/core`), and are mounted by
two hosts: the stdio server in this package (`src/index.ts`, plus `login`/`login_status`/`logout`
and the `path` arguments of `import_content` and `upload_media`), and the hosted server at
`https://mcp.writavo.com/mcp` (the monorepo's `workers/mcp`, a Cloudflare Worker with OAuth 2.1).

It also ships as an Agent Plugin (`plugin.json`, `mcp.json`) and a Claude Code plugin
(`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`) with one skill,
`skills/writavo/SKILL.md`.

## Using Writavo from another project

- Add the hosted server: `claude mcp add --transport http writavo https://mcp.writavo.com/mcp`
  (or `{"type": "http", "url": "https://mcp.writavo.com/mcp"}`). The client signs in with OAuth;
  a person approves in their browser.
- Or run it locally: `{"command": "npx", "args": ["-y", "@writavo/mcp-server"]}`. With no
  `WRITAVO_API_KEY`, call the `login` tool and a person approves in their browser.
- Exact setup for every client (Claude Code, Claude, ChatGPT, Codex, Cursor, VS Code, Gemini CLI,
  Windsurf, Zed), permissions, approvals and troubleshooting: `https://writavo.com/docs/mcp.md`.
  After connecting, call `get_site_info` and `verify_api_key` and tell the person which Site and
  permissions you have.
- Moving a blog in: `https://writavo.com/docs/migrate.md` (the runbook) and the `migrate-content` prompt.
- Read `skills/writavo/SKILL.md` for the order of operations and the mistakes to avoid.
- Documentation over MCP, no key needed: `https://writavo.com/mcp/docs` (Streamable HTTP).
- Everything else an agent needs: `https://writavo.com/llms.txt`, `https://writavo.com/auth.md`,
  `https://writavo.com/openapi.json`.

## Working in this repository

- **Never hand-edit `src/generated/`.** It is produced from `openapi.yaml` by
  `scripts/gen-mcp-tools.mjs`. Change the generator or the specification, then run
  `node scripts/gen-mcp-tools.mjs`.
- **Never hand-edit `openapi.yaml`, the generator scripts or `skills/writavo/SKILL.md`.** They
  are vendored from the main Writavo repository, which owns the contract, and a sync overwrites
  local edits. Changes go there first.
- Build: `npm run build` (checks the generated tools are current, then `tsc`). Test: `npm test`.
- **`src/core/` and everything it imports must stay runtime-agnostic**: no `node:fs`/`node:os`,
  no `process.*`, no import of `config.ts`, `credentials.ts`, `auth/`, `tools/login.ts` or
  `stdio/`, and no key in module state (the Worker serves many people from one isolate). Pass
  what a tool needs through `ToolContext`. The smoke test walks the import graph and fails on a
  violation. Node-only code goes in `src/stdio/` (or the existing stdio modules above).
- The version is `src/core/version.ts`; keep it equal to `package.json`, `server.json` and both
  plugin manifests (the smoke test checks).
- The API version is `/v1` and additive only: tolerate unknown response fields and treat
  read-only enums as open.

## Rules the tools must keep

- Writes create drafts. Publishing is always a separate, explicit tool call.
- `trigger_pipeline_run` is the only tool that spends money. It must stay behind a confirmation.
- Key and webhook management are withheld from the tool surface on purpose. Do not add them. The
  key self-service routes (`/auth/key/*`, extend and revoke) are called by the host itself and
  are withheld too (`HOST_OWNED_PREFIX` in the generator).
- A 428 (`APPROVAL_REQUIRED` / `APPROVAL_PENDING`) is a result, not an error: hand the person the
  link, then repeat the call with `approval_id`. Operations marked `x-writavo-approval` take it.
- Every tool carries annotations; every API request sends `Writavo-Mcp-Tool: <tool>`.
- Never log, print or persist a secret key except to the credentials file, owner-only.
- Errors are branched on `error.code`, never on the message.
