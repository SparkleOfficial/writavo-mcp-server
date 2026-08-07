import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VERSION } from "./config.js";
import { OPERATIONS } from "./generated/operations.js";
import { callOperation, type ToolArgs } from "./tools/call.js";
import { inputShapeFor } from "./tools/schema.js";
import { GET_API_DOCS, handleGetApiDocs } from "./tools/api-docs.js";
import { UPLOAD_MEDIA, handleUploadMedia } from "./tools/upload-media.js";
import {
  apiReferenceResource,
  contentTypesResource,
  errorCodesResource,
  readApiReference,
  readContentTypes,
  readErrorCodes,
} from "./resources/index.js";
import { draftArticlePrompt } from "./prompts/draft-article.js";
import { publishChecklistPrompt } from "./prompts/publish-checklist.js";

const DESCRIPTION =
  "The CMS control plane for a Writavo Site. Create, edit, organise, schedule and publish articles, manage categories, tags, authors and media, and trigger the AI generation pipeline. Every tool is compiled from the published OpenAPI specification. The Site is resolved from the API key, so an assistant can only reach the Site it was given a key for, nothing is published without an explicit confirmed call, and the one billable tool says so.";

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

  return server;
}
