import { z } from "zod";
import { hasApiKey, keyKind, noKeyMessage } from "../config.js";
import { publishableKeyRefusal, text, toolError, type ToolResult } from "../errors.js";
import { importFormatDocument } from "../import/format.js";
import { runImport } from "../import/engine.js";
import type { ToolArgs } from "./call.js";

/**
 * Bring an existing blog into Writavo from a file in the Writavo Import Format. The model's job is
 * to produce that file from whatever the source system is; everything that has to be exactly
 * right (matching, idempotency, dates, images, rate limits, resuming) is done here, in code, where
 * it can be tested, rather than left to a model orchestrating a few hundred tool calls.
 */
export const IMPORT_CONTENT = {
  name: "import_content",
  description:
    "Import a blog into the Site from a JSON file in the Writavo Import Format: articles with their original slugs and original publish dates, drafts kept as drafts, authors, categories and tags, and images copied into the media library. Runs as a dry run by default, which checks everything against the Site and writes nothing. An apply imports one batch per call and saves progress next to the file, so call it again with the same arguments until it reports the import is complete; running it again after that changes nothing. Articles are matched by external_id, so nothing is duplicated. It never deletes or unpublishes anything. Applying with publish true makes articles publicly visible on the customer's own live site, so it needs confirm: true, which you pass only after the user has agreed. Call it with no file_path to get the format's JSON Schema and a sample. Needs a secret key (wv_sk_) with articles, taxonomy, authors and media write scopes.",
  scope: "articles:write",
  inputSchema: {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to the import JSON file. Omit it to get the format description, JSON Schema and a sample instead."),
    dry_run: z
      .boolean()
      .optional()
      .describe("Defaults to true: check the file against the Site and report what would happen, writing nothing. Pass false to import."),
    confirm: z
      .boolean()
      .optional()
      .describe(
        "Required as true for an import that will publish articles or change articles that are already live. Set it only after the user has explicitly agreed. Without it such a call changes nothing and says what it would do.",
      ),
    batch_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many articles one call imports at most. Defaults to 20. A call also stops after about 35 seconds, whatever this is."),
    rehost_images: z
      .boolean()
      .optional()
      .describe("Defaults to true: copy https images (inline, featured, how-to steps, author avatars) into the Site's media library and rewrite their URLs. False keeps every original URL."),
    publish: z
      .boolean()
      .optional()
      .describe("Defaults to true: articles with status published are published with their original dates. False imports everything as a draft and leaves articles already live untouched."),
    retry_failed: z
      .boolean()
      .optional()
      .describe("Try again, once, the articles an earlier call skipped or failed, for example after fixing a slug conflict on the Site. Leave it out otherwise."),
  },
};

export async function handleImportContent(rawArgs: ToolArgs): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as {
    file_path?: string;
    dry_run?: boolean;
    confirm?: boolean;
    batch_size?: number;
    rehost_images?: boolean;
    publish?: boolean;
    retry_failed?: boolean;
  };

  if (!args.file_path) return text(importFormatDocument());

  if (!hasApiKey()) return toolError(noKeyMessage());
  if (keyKind() === "publishable") return publishableKeyRefusal("import_content", "articles:write");

  const batch = Number.isInteger(args.batch_size) ? Math.min(100, Math.max(1, args.batch_size as number)) : 20;
  try {
    return await runImport({
      filePath: args.file_path,
      dryRun: args.dry_run !== false,
      confirm: args.confirm === true,
      batchSize: batch,
      rehostImages: args.rehost_images !== false,
      publish: args.publish !== false,
      retryFailed: args.retry_failed === true,
    });
  } catch (err) {
    return toolError(`import_content failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  }
}
