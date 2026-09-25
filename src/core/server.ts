import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OPERATIONS } from "../generated/operations.js";
import { callOperation, type ToolArgs } from "../tools/call.js";
import { inputShapeFor } from "../tools/schema.js";
import { GET_API_DOCS, handleGetApiDocs } from "../tools/api-docs.js";
import { handleUploadMedia, uploadMediaTool, type LocalFileReader } from "../tools/upload-media.js";
import { START_PLAN_PURCHASE, handleStartPlanPurchase } from "../tools/plan-purchase.js";
import { handleImportContent, importContentTool, type ImportFileSupport } from "../tools/import-content.js";
import {
  apiReferenceResource,
  contentTypesResource,
  errorCodesResource,
  importFormatResource,
  readApiReference,
  readContentTypes,
  readErrorCodes,
  readImportFormat,
} from "../resources/index.js";
import { draftArticlePrompt } from "../prompts/draft-article.js";
import { publishChecklistPrompt } from "../prompts/publish-checklist.js";
import { migrateContentPrompt } from "../prompts/migrate-content.js";
import { DEFAULT_API_BASE } from "./constants.js";
import type { ToolContext } from "./context.js";
import { NOT_SIGNED_IN_REMOTE, NO_API_KEY_MESSAGE } from "./messages.js";
import { VERSION } from "./version.js";

/**
 * THE ONE SET OF TOOLS (MCP-2 item 5). Both hosts mount this: the npm stdio server (plus its
 * sign-in tools and file extras) and the hosted Worker at mcp.writavo.com. Nothing in here, or in
 * anything it imports, may read process.env, touch a filesystem or hold a key in module state:
 * the Worker builds one of these per request, for many people at once, in one isolate.
 */
export interface CoreOptions {
  /** The key for this connection, or null. Null makes every key-requiring tool say how to fix it. */
  apiKey: () => string | null;
  /** Default https://api.writavo.com/v1. */
  apiBase?: string;
  userAgent: string;
  host: "stdio" | "remote";
  /** Host-specific instructions, appended to the not-signed-in reply. */
  notSignedInHint?: string;
  /**
   * Called once per API request; its headers are merged into every request the core makes to the
   * Writavo API, after the core's own. It can never override Authorization or Writavo-Mcp-Tool
   * (nor any other header the core set). The Worker sends X-Writavo-Mcp-Worker and
   * X-Writavo-Client-Ip here, so the gateway rate-limits each person separately. Stdio leaves it unset.
   */
  extraHeaders?: () => Record<string, string>;
}

/**
 * What only the stdio host adds. Deliberately not part of CoreOptions, which is the Worker's
 * contract: these are the local-machine features a hosted server must never grow.
 */
export interface HostExtras {
  /** The full not-signed-in reply, when it depends on host state (an expired saved sign-in, say). */
  notSignedIn?: () => string;
  /** Replaces the server instructions. */
  instructions?: string;
  /** Adds `path` to import_content. */
  importFiles?: ImportFileSupport;
  /** Adds `path` to upload_media. */
  mediaFiles?: LocalFileReader;
  /** Registers the host's own tools (login, login_status, logout) on the same server. */
  registerTools?: (server: McpServer, ctx: ToolContext) => void;
}

/**
 * The server instructions: what an agent connecting cold needs before its first call. Owner
 * requirement (2026-09-25): a person says "install Writavo" or "move my blog to Writavo" and
 * nothing else, so these carry the order of work, the approval protocol and what each refusal
 * means, and point at the docs for the rest. Clients show or truncate instructions, so each stays
 * well under ~6000 characters. No em-dashes or en-dashes: this is shipped copy.
 */
const INSTRUCTIONS_COMMON_START = [
  "Writavo is a CMS for one Site's blog: articles, categories, tags, authors and media, plus an optional AI article pipeline. The tools are generated from Writavo's published OpenAPI specification.",
  "START: call get_site_info (the Site's name, domain and timezone) and verify_api_key (the permissions this connection has). Tell the person which Site you are connected to and what you can and cannot do there. A connection reaches that one Site only; there is no site parameter.",
];

const INSTRUCTIONS_COMMON_END = [
  "DOCS: get_api_docs, and the resources writavo://api-reference, writavo://error-codes and writavo://import-format. Online: https://writavo.com/docs/mcp.md (setup, permissions, approvals, troubleshooting), https://writavo.com/docs/migrate.md (moving a blog in), https://writavo.com/llms.txt.",
  "SAFETY: create_article always makes a private draft. Publishing, scheduling, unpublishing, deleting, importing and pipeline runs are separate explicit calls. When a tool answers \"Nothing has been done\" and asks for confirmation, ask the person and call again with confirm: true only if they agree. trigger_pipeline_run spends the organisation's credits: call it only when the person asks, with max_articles as a ceiling.",
  "APPROVALS: deleting, unpublishing and pipeline runs may also need a person's approval in the Writavo dashboard. The tool then returns a link on https://app.writavo.com/approvals/ and an approval id, and nothing has happened yet. Give the person the link exactly as returned, wait until they say they approved it, then call the same tool with the same arguments plus approval_id. An approval works once and lapses after 24 hours. APPROVAL_PENDING: not decided yet, ask them. APPROVAL_DENIED: stop, tell them, ask what they want instead; never rephrase the request to get around it. APPROVAL_INVALID: call again without approval_id for a new link.",
  "MOVING A BLOG IN: follow the migrate-content prompt or https://writavo.com/docs/migrate.md. Only read the source system. Copy text verbatim. Keep every slug exactly and use each post's ORIGINAL first publication date; never guess a slug, a date or missing text: ask the person. import_content is a dry run by default: show the person its report, fix problems in the document, and import (dry_run false, confirm true) only after they agree. Then verify counts, slugs and dates against the source.",
  "ERRORS: every error reply says what to do next; follow it and do not retry in a loop. AGENT_ACCESS_DISABLED: the organisation turned AI agent access off; tell the person (an owner or admin turns it on in Settings > AI agents). INSUFFICIENT_SCOPE: this connection lacks that permission; tell the person which area needs Read and write, and they reconnect with it. API_KEY_REVOKED, API_KEY_EXPIRED, INVALID_API_KEY: the person signs in again. PAYMENT_METHOD_REQUIRED, NOT_ENTITLED, INSUFFICIENT_CREDITS, SPEND_CAP_REACHED: report it; only the person can fix it, in Billing. RATE_LIMIT_EXCEEDED: wait for Retry-After. NOT_FOUND: no such item on this Site.",
  "Keys, webhooks, billing, team members and roles are managed by people in the dashboard, not through these tools.",
];

const INSTRUCTIONS_STDIO = [
  ...INSTRUCTIONS_COMMON_START,
  "SIGN-IN (this is the local server): if a tool says there is no key, call login, show the person the link and the code it returns, and call login_status every few seconds until it says approved. No restart is needed. logout revokes the key and deletes it from this machine.",
  "FILES: import_content accepts the absolute path of an import file on this machine (any size, imported in batches, progress saved next to the file) or the document inline. upload_media accepts a local path, an https URL or base64.",
  ...INSTRUCTIONS_COMMON_END,
].join("\n\n");

const INSTRUCTIONS_REMOTE = [
  ...INSTRUCTIONS_COMMON_START,
  "SIGN-IN (this is the hosted server at https://mcp.writavo.com/mcp): the person signed in through the browser when they connected, choosing the Site and the permissions. If a tool says this connection carries no credentials, ask them to reconnect or re-authenticate Writavo in this client's MCP or connector settings.",
  "FILES: this hosted server cannot read the person's files. import_content takes the import document inline, at most 50 articles and 2 MB per call, so split a bigger blog into several documents. upload_media takes an https URL or base64. Importing from a file on disk, or images from local paths, needs the local server: npx -y @writavo/mcp-server (setup at https://writavo.com/docs/mcp.md).",
  ...INSTRUCTIONS_COMMON_END,
].join("\n\n");

/** Annotations for the hand-written tools. Every tool here reaches one closed system: the Site. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** The hand-written tools every host has. The stdio host adds login, login_status and logout. */
export const CORE_LOCAL_TOOL_NAMES = ["upload_media", "get_api_docs", "start_plan_purchase", "import_content"] as const;

export function createWritavoMcpServer(opts: CoreOptions): McpServer {
  return buildWritavoMcpServer(opts, {});
}

/** The per-server context every tool reads, built from the options and nothing else. */
export function toolContext(opts: CoreOptions, notSignedIn?: () => string): ToolContext {
  const hint = opts.notSignedInHint?.trim();
  const fallback = opts.host === "remote" ? NOT_SIGNED_IN_REMOTE : NO_API_KEY_MESSAGE;
  return {
    apiKey: () => opts.apiKey() ?? "",
    apiBase: (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ""),
    userAgent: opts.userAgent,
    host: opts.host,
    ...(opts.extraHeaders ? { extraHeaders: opts.extraHeaders } : {}),
    notSignedIn: () => {
      const base = notSignedIn ? notSignedIn() : fallback;
      return hint ? `${base}\n\n${hint}` : base;
    },
  };
}

export function buildWritavoMcpServer(opts: CoreOptions, extras: HostExtras): McpServer {
  const ctx = toolContext(opts, extras.notSignedIn);

  const server = new McpServer(
    { name: "writavo", version: VERSION },
    { instructions: extras.instructions ?? (opts.host === "remote" ? INSTRUCTIONS_REMOTE : INSTRUCTIONS_STDIO) },
  );

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

  const upload = uploadMediaTool(extras.mediaFiles ?? null);
  server.registerTool(
    upload.name,
    {
      title: "Upload an image",
      description: upload.description,
      inputSchema: upload.inputSchema,
      annotations: { title: "Upload an image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: unknown) => handleUploadMedia(ctx, (args ?? {}) as ToolArgs, extras.mediaFiles ?? null),
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

  const importTool = importContentTool(extras.importFiles ?? null);
  server.registerTool(
    importTool.name,
    {
      title: "Import a blog",
      description: importTool.description,
      inputSchema: importTool.inputSchema,
      // Idempotent by external_id; it never deletes or unpublishes, so not destructive.
      annotations: { title: "Import a blog", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: unknown) => handleImportContent(ctx, (args ?? {}) as ToolArgs, extras.importFiles ?? null),
  );

  extras.registerTools?.(server, ctx);

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
    contentTypesResource.name,
    contentTypesResource.uri,
    { description: contentTypesResource.description, mimeType: contentTypesResource.mimeType },
    async () => readContentTypes(ctx),
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
    async (args) => migrateContentPrompt(args as { source?: string }, opts.host),
  );

  return server;
}
