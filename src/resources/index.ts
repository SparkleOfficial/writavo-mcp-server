import { apiRequest } from "../api/client.js";
import { ERROR_CATALOG } from "../generated/errors.js";
import { referenceSection } from "../generated/reference.js";
import { hasKey, type ToolContext } from "../core/context.js";
import { redact } from "../core/redact.js";
import { importFormatDocument } from "../import/format.js";

export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface ResourceContents {
  contents: { uri: string; mimeType: string; text: string }[];
  /** The SDK's result type is open. Declared so a handler is assignable to it. */
  [key: string]: unknown;
}

const contents = (definition: ResourceDefinition, body: string): ResourceContents => ({
  contents: [{ uri: definition.uri, mimeType: definition.mimeType, text: redact(body) }],
});

/**
 * The three resources API-6 §3 asks for, plus the import format. The first three are generated
 * from openapi.yaml except the content types, which are per Site and can only come from the Site.
 * The reference implementation keeps its equivalent hand-written; here a stale resource is a
 * build failure. The import format is emitted from its own zod definition (import/format.ts).
 */
export const apiReferenceResource: ResourceDefinition = {
  uri: "writavo://api-reference",
  name: "Writavo Content API reference",
  description: "Every endpoint, scope and rule, compiled from the published OpenAPI specification.",
  mimeType: "text/markdown",
};

export function readApiReference(): ResourceContents {
  return contents(apiReferenceResource, referenceSection("all"));
}

export const errorCodesResource: ResourceDefinition = {
  uri: "writavo://error-codes",
  name: "Writavo API error codes",
  description: "Every error code, its HTTP status, what it means and what to change.",
  mimeType: "text/markdown",
};

export function readErrorCodes(): ResourceContents {
  const body = [
    "# Error codes",
    "",
    ...ERROR_CATALOG.flatMap((entry) => [
      `## ${entry.code} (HTTP ${entry.http})`,
      "",
      entry.meaning,
      "",
      `What to do. ${entry.action}`,
      ...entry.links.map((link) => `- ${link.label}: ${link.url}`),
      "",
    ]),
  ].join("\n");
  return contents(errorCodesResource, body);
}

export const contentTypesResource: ResourceDefinition = {
  uri: "writavo://content-types",
  name: "Content types for the connected Site",
  description:
    "The article formats available on the Site this key belongs to. A format is an SEO blueprint that shapes how an article is structured.",
  mimeType: "application/json",
};

export async function readContentTypes(ctx: ToolContext): Promise<ResourceContents> {
  if (!hasKey(ctx)) {
    return contents(
      contentTypesResource,
      JSON.stringify(
        {
          available: false,
          reason:
            ctx.host === "stdio"
              ? "No API key is configured, and content types are per Site. Call the login tool, or configure WRITAVO_API_KEY, to read the real list."
              : "This connection has no Writavo credentials, and content types are per Site. Reconnect Writavo in the assistant to read the real list.",
          reference: "writavo://api-reference",
        },
        null,
        2,
      ),
    );
  }
  try {
    const response = await apiRequest<{ items: unknown[] }>(ctx, { method: "GET", path: "/content-types" });
    return contents(contentTypesResource, JSON.stringify(response.data, null, 2));
  } catch (err) {
    return contents(
      contentTypesResource,
      JSON.stringify(
        { available: false, reason: err instanceof Error ? err.message : String(err) },
        null,
        2,
      ),
    );
  }
}

export const importFormatResource: ResourceDefinition = {
  uri: "writavo://import-format",
  name: "Writavo Import Format v1",
  description:
    "The file format import_content reads to bring an existing blog into a Site: every field explained, a sample document, and the JSON Schema, emitted from the same definition the importer validates with.",
  mimeType: "text/markdown",
};

export function readImportFormat(): ResourceContents {
  return contents(importFormatResource, importFormatDocument());
}
