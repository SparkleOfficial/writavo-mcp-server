import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OPERATIONS } from "../generated/operations.js";
import { callOperation, type ToolArgs } from "../tools/call.js";
import { inputShapeFor } from "../tools/schema.js";
import { GET_API_DOCS, handleGetApiDocs } from "../tools/api-docs.js";
import { UPLOAD_MEDIA, handleUploadMedia } from "../tools/upload-media.js";
import { START_PLAN_PURCHASE, handleStartPlanPurchase } from "../tools/plan-purchase.js";
import { handleImportContent, importContentTool } from "../tools/import-content.js";
import type { ImportJobStore } from "../import/jobs.js";
import type { ImportBudget } from "../import/engine.js";
import {
  READ_WRITAVO_ACTION,
  RUN_WRITAVO_ACTION,
  SEARCH_WRITAVO_ACTIONS,
  handleReadAction,
  handleRunAction,
  handleSearchActions,
} from "../tools/actions.js";
import {
  apiReferenceResource,
  formatsResource,
  errorCodesResource,
  importFormatResource,
  readApiReference,
  readFormats,
  readErrorCodes,
  readImportFormat,
} from "../resources/index.js";
import { draftArticlePrompt } from "../prompts/draft-article.js";
import { publishChecklistPrompt } from "../prompts/publish-checklist.js";
import { migrateContentPrompt } from "../prompts/migrate-content.js";
import { DEFAULT_API_BASE } from "./constants.js";
import type { ToolContext } from "./context.js";
import { NOT_SIGNED_IN_REMOTE } from "./messages.js";
import { VERSION } from "./version.js";

/**
 * THE ONE SET OF TOOLS (MCP-2 item 5), mounted by the hosted Worker at mcp.writavo.com, the only
 * Writavo MCP server there is (owner ruling 2026-09-28: the npm stdio package is discontinued).
 * Nothing in here, or in anything it imports, may read process.env, touch a filesystem or hold a
 * key in module state: the Worker builds one of these per request, for many people at once, in
 * one isolate.
 */
export interface CoreOptions {
  /** The key for this connection, or null. Null makes every key-requiring tool say how to fix it. */
  apiKey: () => string | null;
  /** Default https://api.writavo.com/v1. */
  apiBase?: string;
  userAgent: string;
  /** Always "remote": the hosted server is the only host. Optional, and kept so callers that name it still compile. */
  host?: "remote";
  /** Host-specific instructions, appended to the not-signed-in reply. */
  notSignedInHint?: string;
  /**
   * Called once per API request; its headers are merged into every request the core makes to the
   * Writavo API, after the core's own. It can never override Authorization or Writavo-Mcp-Tool
   * (nor any other header the core set). The Worker sends X-Writavo-Mcp-Worker and
   * X-Writavo-Client-Ip here, so the gateway rate-limits each person separately.
   */
  extraHeaders?: () => Record<string, string>;
  /**
   * Import jobs (src/import/jobs.ts): where import_content keeps a document and its progress on
   * the server, scoped to this connection. Adds `url`, `upload` and `import_id` to import_content.
   * The Worker passes one built for the caller's key; a host without storage leaves it unset.
   */
  importJobs?: ImportJobStore;
  /**
   * The time and request budget of one foreground import_content call. The Worker sets it from
   * its plan (a free Workers plan allows 50 outbound requests per invocation); unset, the
   * engine's default time budget and no request cap.
   */
  importBudget?: ImportBudget;
}

/**
 * The server instructions: what an agent connecting cold needs before its first call. Owner
 * requirement (2026-09-25): a person says "install Writavo" or "move my blog to Writavo" and
 * nothing else, so these carry the order of work, the approval protocol and what each refusal
 * means, and point at the docs for the rest. Clients show or truncate instructions, so each stays
 * well under ~6000 characters. No em-dashes or en-dashes: this is shipped copy.
 */
const INSTRUCTIONS_START = [
  "Writavo is a CMS for one Site's blog: articles, categories, tags, authors and media, plus an optional AI article pipeline, delivery to the Site's own domain, SEO tools, the team and billing. The tools are generated from Writavo's published OpenAPI specification.",
  "START: call get_site_info (the Site's name, domain and timezone) and verify_api_key (the permissions this connection has; get_api_docs section tools lists what each tool and action needs). Tell the person which Site you are connected to and what you can and cannot do there. A connection reaches that one Site only; there is no site parameter.",
  "ACTIONS: articles, categories, tags, authors, media and pipeline runs have their own tools. Everything else is an action: Site settings and the knowledge profile, the organisation, formats and prompts, the pipeline's configuration and content plan, delivery and domains, SEO, outreach, the team and roles, billing, insights and logs. Call search_writavo_actions with a few words (and an area if you know it), then the runner each result names: read_writavo_action for reads, run_writavo_action for changes, with the operation_id and arguments it returned. For settings, SEO, delivery, team and billing questions, read first before you change anything. If a search returns a never_through_an_agent result, stop and give the person its next_step.",
];

const INSTRUCTIONS_END = [
  "DOCS: get_api_docs, and the resources writavo://api-reference, writavo://error-codes and writavo://import-format. Online: https://writavo.com/docs/mcp.md (setup, permissions, approvals, troubleshooting), https://writavo.com/docs/migrate.md (moving a blog in), https://writavo.com/llms.txt.",
  "SAFETY: create_article always makes a private draft. Publishing, scheduling, unpublishing, deleting, importing and pipeline runs are separate explicit calls. When a tool answers \"Nothing has been done\" and asks for confirmation, ask the person and call again with confirm: true only if they agree. trigger_pipeline_run, and every action whose search result says it spends credits or money, costs the organisation money: run them only when the person asks.",
  "APPROVALS: some calls need a person's approval in the Writavo dashboard. Deleting and unpublishing content may, when the organisation requires it; team changes, paid scans, pipeline runs and turning the pipeline up, custom domains, publishing the hosted site, CMS connections and pushes, auto-refill, raising a credit cap and keeping the plan always do. The call then returns a link on https://app.writavo.com/approvals/ and an approval id, and nothing has happened yet. Give the person the link exactly as returned, wait until they say they approved it, then call again with the same arguments plus approval_id. An approval works once and lapses after 24 hours. APPROVAL_PENDING: not decided yet, ask them. APPROVAL_DENIED: stop, tell them, ask what they want instead; never rephrase the request to get around it. APPROVAL_INVALID: call again without approval_id for a new link.",
  "MOVING A BLOG IN: follow the migrate-content prompt or https://writavo.com/docs/migrate.md. Only read the source system. Copy text verbatim. Keep every slug exactly and use each post's ORIGINAL first publication date; never guess a slug, a date or missing text: ask the person. import_content is a dry run by default: show the person its report, fix problems in the document, and import (dry_run false, confirm true) only after they agree. Then verify counts, slugs and dates against the source.",
  "ERRORS: every error reply says what to do next; follow it and do not retry in a loop. AGENT_ACCESS_DISABLED: the organisation turned AI agent access off; tell the person (an owner or admin turns it on in Settings > AI agents). INSUFFICIENT_SCOPE: this connection lacks that permission; tell the person which area needs Read or Read and write; they add it in Settings > AI agents (Permissions on this connection) without signing in again. API_KEY_REVOKED, API_KEY_EXPIRED, INVALID_API_KEY: the person signs in again. PAYMENT_METHOD_REQUIRED, NOT_ENTITLED, INSUFFICIENT_CREDITS, SPEND_CAP_REACHED: report it; only the person can fix it, in Billing. PREREQUISITE_MISSING: do the setup step the message names, then retry. FEATURE_UNAVAILABLE: switched off by Writavo; use the free alternative named. RATE_LIMIT_EXCEEDED: wait for Retry-After. NOT_FOUND: no such item on this Site.",
  "NEVER through these tools (a person does them in the dashboard; give them the link, which get_api_docs section tools lists for each): AI agent settings, approving or widening your own access (including the access of the person you act for), deleting a Site or the organisation, card details, plan changes (use start_plan_purchase), ownership, the outreach policy and mailbox, CMS and Bing credentials, API keys and webhooks.",
];

const INSTRUCTIONS = [
  ...INSTRUCTIONS_START,
  "SIGN-IN (this is the hosted server at https://mcp.writavo.com/mcp): the person signed in through the browser when they connected, choosing the Site and the permissions. If a tool says this connection carries no credentials, ask them to reconnect or re-authenticate Writavo in this client's MCP or connector settings.",
  "FILES: this hosted server cannot read the person's files, but import_content keeps each document on the server as an import with its progress, sent once and then named by its import_id. Ways in, best first: upload: true and run the curl command it returns (up to 10 MB, never through this conversation); url for a file at an https URL; or, for a small document only, data in parts of at most 50 articles and 512 KB, each part after the first with the import_id. Dry-run with the import_id and show the person the report. An apply (dry_run false) runs IN THE BACKGROUND until complete and returns at once: check it with import_id and status: true every minute or two; never apply again while it runs. Do not switch to another server for this. upload_media takes an https URL or base64 (a local image: read it, send base64).",
  ...INSTRUCTIONS_END,
].join("\n\n");

/** Annotations for the hand-written tools. Every tool here reaches one closed system: the Site. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The hand-written tools: every tool that is not a row of the generated table. */
export const CORE_LOCAL_TOOL_NAMES = [
  "upload_media",
  "get_api_docs",
  "start_plan_purchase",
  "import_content",
  "search_writavo_actions",
  "read_writavo_action",
  "run_writavo_action",
] as const;

/** The per-server context every tool reads, built from the options and nothing else. */
export function toolContext(opts: CoreOptions): ToolContext {
  const hint = opts.notSignedInHint?.trim();
  return {
    apiKey: () => opts.apiKey() ?? "",
    apiBase: (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
    userAgent: opts.userAgent,
    ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    notSignedIn: () => (hint ? `${NOT_SIGNED_IN_REMOTE}\n\n${hint}` : NOT_SIGNED_IN_REMOTE),
  };
}

export function createWritavoMcpServer(opts: CoreOptions): McpServer {
  const ctx = toolContext(opts);

  const server = new McpServer({ name: "writavo", version: VERSION }, { instructions: INSTRUCTIONS });

  // --- Tools -------------------------------------------------------------
  // One registration per row of the generated table. There is no per tool file and no per tool
  // schema, because both would be places for a hand edit to disagree with openapi.yaml. Adding an
  // endpoint to the specification and running `pnpm mcp:gen` is the whole of adding a tool.
  for (const operation of OPERATIONS) {
    server.registerTool(
      operation.tool,
      {
        title: operation.summary,
        description: operation.description,
        inputSchema: inputShapeFor(operation),
        annotations: operation.annotations,
      },
      async (args: unknown) => callOperation(ctx, operation, (args ?? {}) as ToolArgs),
    );
  }

  server.registerTool(
    UPLOAD_MEDIA.name,
    {
      title: "Upload an image",
      description: UPLOAD_MEDIA.description,
      inputSchema: UPLOAD_MEDIA.inputSchema,
      annotations: { title: "Upload an image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: unknown) => handleUploadMedia(ctx, (args ?? {}) as ToolArgs),
  );

  server.registerTool(
    GET_API_DOCS.name,
    {
      title: "Read the API reference",
      description: GET_API_DOCS.description,
      inputSchema: GET_API_DOCS.inputSchema,
      annotations: { title: "Read the API reference", ...READ_ONLY },
    },
    async (args: unknown) => handleGetApiDocs((args ?? {}) as ToolArgs),
  );

  // --- Billing and import --------------------------------------------------
  // Hand-written like upload_media: each is a flow (a deep link, a resumable batch job) rather
  // than a single request, so neither is a row of the spec.
  server.registerTool(
    START_PLAN_PURCHASE.name,
    {
      title: "Get a plan purchase link",
      description: START_PLAN_PURCHASE.description,
      inputSchema: START_PLAN_PURCHASE.inputSchema,
      annotations: { title: "Get a plan purchase link", ...READ_ONLY },
    },
    async (args: unknown) => handleStartPlanPurchase(ctx, (args ?? {}) as ToolArgs),
  );

  const importTool = importContentTool(opts.importJobs ?? null);
  server.registerTool(
    importTool.name,
    {
      title: "Import a blog",
      description: importTool.description,
      inputSchema: importTool.inputSchema,
      // Idempotent by external_id; it never deletes or unpublishes, so not destructive.
      annotations: { title: "Import a blog", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: unknown) => handleImportContent(ctx, (args ?? {}) as ToolArgs, opts.importJobs ?? null, opts.importBudget),
  );

  // --- Actions (MCP-3 decision 5) -----------------------------------------
  // Everything past the everyday content tools, behind three tools instead of a hundred: a search
  // over the generated ACTIONS catalog, and two runners that validate against the chosen row and
  // then go through callOperation like every generated tool. The runners are split by method so
  // a client can let the read-only one run unasked without that ever reaching a write.
  server.registerTool(
    SEARCH_WRITAVO_ACTIONS.name,
    {
      title: "Find a Writavo action",
      description: SEARCH_WRITAVO_ACTIONS.description,
      inputSchema: SEARCH_WRITAVO_ACTIONS.inputSchema,
      annotations: { title: "Find a Writavo action", ...READ_ONLY },
    },
    async (args: unknown) => handleSearchActions((args ?? {}) as ToolArgs),
  );

  server.registerTool(
    READ_WRITAVO_ACTION.name,
    {
      title: "Read through a Writavo action",
      description: READ_WRITAVO_ACTION.description,
      inputSchema: READ_WRITAVO_ACTION.inputSchema,
      // GET operations only (the handler refuses anything else), so this is honestly read only.
      annotations: { title: "Read through a Writavo action", ...READ_ONLY },
    },
    async (args: unknown) => handleReadAction(ctx, (args ?? {}) as ToolArgs),
  );

  server.registerTool(
    RUN_WRITAVO_ACTION.name,
    {
      title: "Run a Writavo action",
      description: RUN_WRITAVO_ACTION.description,
      inputSchema: RUN_WRITAVO_ACTION.inputSchema,
      // Some actions remove things (a member, a domain, a format), so the tool as a whole is
      // declared destructive; each action still asks first and may need approval on its own terms.
      annotations: { title: "Run a Writavo action", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args: unknown) => handleRunAction(ctx, (args ?? {}) as ToolArgs),
  );

  // --- Resources ---------------------------------------------------------
  server.registerResource(
    apiReferenceResource.name,
    apiReferenceResource.uri,
    { description: apiReferenceResource.description, mimeType: apiReferenceResource.mimeType },
    async () => readApiReference(),
  );

  server.registerResource(
    errorCodesResource.name,
    errorCodesResource.uri,
    { description: errorCodesResource.description, mimeType: errorCodesResource.mimeType },
    async () => readErrorCodes(),
  );

  server.registerResource(
    formatsResource.name,
    formatsResource.uri,
    { description: formatsResource.description, mimeType: formatsResource.mimeType },
    async () => readFormats(ctx),
  );

  server.registerResource(
    importFormatResource.name,
    importFormatResource.uri,
    { description: importFormatResource.description, mimeType: importFormatResource.mimeType },
    async () => readImportFormat(),
  );

  // --- Prompts -----------------------------------------------------------
  server.registerPrompt(
    "draft-article",
    {
      title: "Draft an article",
      description:
        "Research a topic and write a draft in the Site's own voice, saved as a draft. It is never published or scheduled by this prompt.",
      argsSchema: {
        topic: z.string().describe("What the article should be about."),
        angle: z.string().optional().describe("The specific take, if you have one in mind."),
      },
    },
    async (args) => draftArticlePrompt(args as { topic: string; angle?: string }),
  );

  server.registerPrompt(
    "publish-checklist",
    {
      title: "Walk a draft to publication",
      description:
        "Check an existing draft's title, slug, SEO fields, excerpt, category, author and featured image, apply the fixes, then ask before publishing.",
      argsSchema: {
        article_id: z.string().describe("The id of the draft to prepare."),
      },
    },
    async (args) => publishChecklistPrompt(args as { article_id: string }),
  );

  server.registerPrompt(
    "migrate-content",
    {
      title: "Move a blog to Writavo",
      description:
        "Move an existing blog from another system into this Site faithfully: sign in, inspect the source, map it to the import format, dry run, fix, import with confirmation, and verify. Slugs, original dates and drafts are kept.",
      argsSchema: {
        source: z
          .string()
          .optional()
          .describe("Where the blog's content lives now, for example a database, an export file or a folder in the workspace."),
      },
    },
    async (args) => migrateContentPrompt(args as { source?: string }),
  );

  return server;
}
