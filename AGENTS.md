# AGENTS.md

Instructions for AI coding agents working in this repository, and for agents that want to use
Writavo from inside another project.

## What this repository is

`@writavo/mcp-server`: an MCP server, spoken over stdio, for the Writavo Content API
(`https://api.writavo.com/v1`). Its tools are **generated** from the OpenAPI specification, so
the server cannot expose an operation the API does not have.

It also ships as an Agent Plugin (`plugin.json`, `mcp.json`) with one skill,
`skills/writavo/SKILL.md`.

## Using Writavo from another project

- Add the server: `{"command": "npx", "args": ["-y", "@writavo/mcp-server"]}`. With no
  `WRITAVO_API_KEY`, call the `login` tool and a person approves in their browser.
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
- Build: `npm run build` (checks the generated tools are current, then `tsc`).
- The API version is `/v1` and additive only: tolerate unknown response fields and treat
  read-only enums as open.

## Rules the tools must keep

- Writes create drafts. Publishing is always a separate, explicit tool call.
- `trigger_pipeline_run` is the only tool that spends money. It must stay behind a confirmation.
- Key and webhook management are withheld from the tool surface on purpose. Do not add them.
- Never log, print or persist a secret key except to the credentials file, owner-only.
- Errors are branched on `error.code`, never on the message.
