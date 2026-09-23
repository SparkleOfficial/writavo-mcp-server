import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "./config.js";
import { OPERATIONS } from "./generated/operations.js";
import { callOperation, type ToolArgs } from "./tools/call.js";
import { inputShapeFor } from "./tools/schema.js";
import { GET_API_DOCS, handleGetApiDocs } from "./tools/api-docs.js";
import { UPLOAD_MEDIA, handleUploadMedia } from "./tools/upload-media.js";
import { LOGIN, LOGIN_STATUS, LOGOUT, handleLogin, handleLoginStatus, handleLogout } from "./tools/login.js";
import { START_PLAN_PURCHASE, handleStartPlanPurchase } from "./tools/plan-purchase.js";
import { IMPORT_CONTENT, handleImportContent } from "./tools/import-content.js";
import {
  apiReferenceResource,
  contentTypesResource,
  errorCodesResource,
  importFormatResource,
  readApiReference,
  readContentTypes,
  readErrorCodes,
  readImportFormat,
} from "./resources/index.js";
import { draftArticlePrompt } from "./prompts/draft-article.js";
import { publishChecklistPrompt } from "./prompts/publish-checklist.js";
import { migrateContentPrompt } from "./prompts/migrate-content.js";

const DESCRIPTION =
  "The CMS control plane for a Writavo Site. Create, edit, organise, schedule and publish articles, manage categories, tags, authors and media, import an existing blog, and trigger the AI generation pipeline. The generated tools are compiled from the published OpenAPI specification. Without a key, call login: the user approves in their browser and the key is picked up with no restart. The Site is resolved from the key, so an assistant can only reach the Site it was given, nothing is published without an explicit confirmed call, and the one billable tool says so.";

/**
 * The tools written by hand rather than generated from a row of openapi.yaml. Exported so the
 * smoke test can count the surface without a second list to keep in step. Every name here must
 * also be in LOCAL_TOOLS in scripts/mcp-surface.mjs, which is what the docs page lists.
 */
export const LOCAL_TOOL_NAMES = [
  UPLOAD_MEDIA.name,
  GET_API_DOCS.name,
  LOGIN.name,
  LOGIN_STATUS.name,
  LOGOUT.name,
  START_PLAN_PURCHASE.name,
  IMPORT_CONTENT.name,
] as const;

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "writavo", version: VERSION },
    { instructions: DESCRIPTION },
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
        annotations: {
          title: operation.summary,
          readOnlyHint: operation.readOnly,
          destructiveHint: operation.method === "DELETE",
          idempotentHint: operation.method !== "POST",
          openWorldHint: true,
        },
      },
      async (args: unknown) => callOperation(operation, (args ?? {}) as ToolArgs),
    );
  }

  server.registerTool(
    UPLOAD_MEDIA.name,
    {
      title: "Upload an image",
      description: UPLOAD_MEDIA.description,
      inputSchema: UPLOAD_MEDIA.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args: unknown) => handleUploadMedia((args ?? {}) as ToolArgs),
  );

  server.registerTool(
    GET_API_DOCS.name,
    {
      title: "Read the API reference",
      description: GET_API_DOCS.description,
      inputSchema: GET_API_DOCS.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args: unknown) => handleGetApiDocs((args ?? {}) as ToolArgs),
  );

  // --- Sign-in, billing and import --------------------------------------
  // Hand-written like upload_media: each one is a local flow (a background poll, a deep link, a
  // resumable batch job) rather than a single request, so none of them is a row of the spec.
  server.registerTool(
    LOGIN.name,
    {
      title: "Sign in through the browser",
      description: LOGIN.description,
      inputSchema: LOGIN.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: unknown) => handleLogin((args ?? {}) as ToolArgs),
  );

  server.registerTool(
    LOGIN_STATUS.name,
    {
      title: "Check sign-in",
      description: LOGIN_STATUS.description,
      inputSchema: LOGIN_STATUS.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => handleLoginStatus(),
  );

  server.registerTool(
    LOGOUT.name,
    {
      title: "Sign out",
      description: LOGOUT.description,
      inputSchema: LOGOUT.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => handleLogout(),
  );

  server.registerTool(
    START_PLAN_PURCHASE.name,
    {
      title: "Get a plan purchase link",
      description: START_PLAN_PURCHASE.description,
      inputSchema: START_PLAN_PURCHASE.inputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (args: unknown) => handleStartPlanPurchase((args ?? {}) as ToolArgs),
  );

  server.registerTool(
    IMPORT_CONTENT.name,
    {
      title: "Import a blog",
      description: IMPORT_CONTENT.description,
      inputSchema: IMPORT_CONTENT.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: unknown) => handleImportContent((args ?? {}) as ToolArgs),
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
    contentTypesResource.name,
    contentTypesResource.uri,
    { description: contentTypesResource.description, mimeType: contentTypesResource.mimeType },
    async () => readContentTypes(),
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
