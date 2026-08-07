import { z } from "zod";
import { REFERENCE_SECTIONS, referenceSection } from "../generated/reference.js";
import { text, toolError, type ToolResult } from "../errors.js";
import type { ToolArgs } from "./call.js";

const SECTION_IDS = REFERENCE_SECTIONS.map((s) => s.id);

/**
 * The one tool that works with no key at all (API-6 §4). Its content is compiled from
 * openapi.yaml, so a person can read the entire contract, decide whether Writavo is worth signing
 * up for, and know what the assistant will be able to do before handing it a credential.
 */
export const GET_API_DOCS = {
  name: "get_api_docs",
  description: `Read the Writavo Content API reference: what the API does, how keys and scopes work, every endpoint, every error code and what to do about each one. Generated from the published OpenAPI specification, so it is exactly what the API implements. No API key required. Sections: ${[...SECTION_IDS, "all"].join(", ")}.`,
  inputSchema: {
    section: z
      .enum(["all", ...SECTION_IDS] as [string, ...string[]])
      .optional()
      .describe('Which part to read. Defaults to "overview". Use "all" for the whole reference.'),
  },
};

export function handleGetApiDocs(rawArgs: ToolArgs): ToolResult {
  const section = String((rawArgs ?? {}).section ?? "overview");
  const body = referenceSection(section);
  if (!body) {
    return toolError(`There is no "${section}" section. Available: ${[...SECTION_IDS, "all"].join(", ")}.`);
  }
  return text(body);
}
