import { z } from "zod";
import { hasKey, keyKindOf, forTool, type ToolContext } from "../core/context.js";
import { publishableKeyRefusal, text, toolError, type ToolResult } from "../errors.js";
import { importFormatDocument } from "../import/format.js";
import { runImport, type ImportSource } from "../import/engine.js";
import type { ToolArgs } from "./call.js";

/**
 * Bring an existing blog into Writavo from a document in the Writavo Import Format. The model's
 * job is to produce that document from whatever the source system is; everything that has to be
 * exactly right (matching, idempotency, dates, images, rate limits, resuming) is done here, in
 * code, where it can be tested, rather than left to a model orchestrating a few hundred tool calls.
 *
 * Two ways in. `data` is the document inline, which works everywhere, the hosted server included,
 * and is capped per call. `path` is a file on this machine, which only the stdio host offers: it
 * has no size cap, imports in batches and keeps a progress file beside the document. The host
 * injects file support; the tool itself never touches a filesystem.
 */

/** Per call, for an inline document. Past this the document belongs in several calls, or a file. */
export const MAX_INLINE_ARTICLES = 50;
export const MAX_INLINE_BYTES = 2 * 1024 * 1024;

/** What a host that has a filesystem adds: turn a path into a document and a progress store. */
export interface ImportFileSupport {
  open(path: string): Promise<ImportSource | ToolResult>;
}

const NAME = "import_content";

function description(withFiles: boolean): string {
  return [
    "Import a blog into the Site from a document in the Writavo Import Format: articles with their original slugs and original publish dates, drafts kept as drafts, authors, categories and tags, and images copied into the media library.",
    withFiles
      ? `Give the document either inline as data (at most ${MAX_INLINE_ARTICLES} articles and 2 MB per call) or as the absolute path of a JSON file on this machine (no size limit; progress is saved next to the file).`
      : `Give the document inline as data, at most ${MAX_INLINE_ARTICLES} articles and 2 MB per call; split a bigger blog across several calls, each carrying the authors, categories and tags its articles use.`,
    "Runs as a dry run by default, which checks everything against the Site and writes nothing. An apply imports as much as fits in one call and says what is left.",
    "Articles are matched by external_id, so running it again updates rather than duplicates. It never deletes or unpublishes anything.",
    "Applying with publish true makes articles publicly visible on the customer's own live site, so it needs confirm: true, which you pass only after the user has agreed.",
    "Call it with no document to get the format's JSON Schema and a sample.",
    "Needs a secret key (wv_sk_) with articles, taxonomy, authors and media write scopes.",
  ].join(" ");
}

function inputSchema(withFiles: boolean): Record<string, z.ZodTypeAny> {
  return {
    data: z
      .union([z.record(z.unknown()), z.string()])
      .optional()
      .describe(
        `The import document itself, as a JSON object (or its JSON text): { "format": "writavo-import", "version": 1, "articles": [...] }. At most ${MAX_INLINE_ARTICLES} articles and 2 MB per call.${withFiles ? " Give this or path, not both." : ""} Omit it to get the format description, JSON Schema and a sample instead.`,
      ),
    ...(withFiles
      ? {
          path: z
            .string()
            .optional()
            .describe("Absolute path to an import JSON file on this machine. Give this or data, not both. No size limit: it is imported in batches, with progress saved next to the file."),
        }
      : {}),
    dry_run: z
      .boolean()
      .optional()
      .describe("Defaults to true: check the document against the Site and report what would happen, writing nothing. Pass false to import."),
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
      .describe(
        withFiles
          ? "How many articles one call imports at most. Defaults to 20 for a file and to the whole document for inline data. A call also stops after about 35 seconds, whatever this is."
          : "How many articles one call imports at most. Defaults to the whole document. A call also stops after about 35 seconds, whatever this is.",
      ),
    rehost_images: z
      .boolean()
      .optional()
      .describe("Defaults to true: copy https images (inline, featured, how-to steps, author avatars) into the Site's media library and rewrite their URLs. False keeps every original URL."),
    publish: z
      .boolean()
      .optional()
      .describe("Defaults to true: articles with status published are published with their original dates. False imports everything as a draft and leaves articles already live untouched."),
    ...(withFiles
      ? {
          retry_failed: z
            .boolean()
            .optional()
            .describe("For a file import: try again, once, the articles an earlier call skipped or failed, for example after fixing a slug conflict on the Site. Leave it out otherwise."),
        }
      : {}),
  };
}

/** The tool as a host registers it. File support is what makes `path` appear. */
export function importContentTool(files: ImportFileSupport | null) {
  return {
    name: NAME,
    description: description(files !== null),
    scope: "articles:write",
    inputSchema: inputSchema(files !== null),
  };
}

/** The remote-safe definition, kept for callers that want the name and text without a host. */
export const IMPORT_CONTENT = importContentTool(null);

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** An inline document, parsed and held to the per-call limits. */
function inlineSource(data: unknown): ImportSource | ToolResult {
  let serialised: string;
  let document: unknown;
  if (typeof data === "string") {
    serialised = data;
    try {
      document = JSON.parse(data);
    } catch (err) {
      return toolError(`data is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Send the import document as a JSON object.`);
    }
  } else {
    document = data;
    serialised = JSON.stringify(data) ?? "";
  }

  const size = byteLength(serialised);
  if (size > MAX_INLINE_BYTES) {
    return toolError(
      `The inline document is ${size} bytes, and one call takes at most ${MAX_INLINE_BYTES} (2 MB). Nothing was checked or written. Split it into several documents of at most ${MAX_INLINE_ARTICLES} articles, each carrying the authors, categories and tags its articles use, and send them one call at a time.`,
    );
  }
  const articles = (document as { articles?: unknown } | null)?.articles;
  if (Array.isArray(articles) && articles.length > MAX_INLINE_ARTICLES) {
    return toolError(
      `The inline document has ${articles.length} articles, and one call takes at most ${MAX_INLINE_ARTICLES}. Nothing was checked or written. Split it into documents of at most ${MAX_INLINE_ARTICLES} articles, each carrying the authors, categories and tags its articles use, and send them one call at a time. Articles are matched by external_id, so the order of the calls does not matter and nothing is duplicated.`,
    );
  }
  return { label: "the inline document", document, store: null, reference: null, lockKey: null };
}

export async function handleImportContent(ctx: ToolContext, rawArgs: ToolArgs, files: ImportFileSupport | null = null): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as {
    data?: unknown;
    path?: string;
    dry_run?: boolean;
    confirm?: boolean;
    batch_size?: number;
    rehost_images?: boolean;
    publish?: boolean;
    retry_failed?: boolean;
  };

  const hasData = args.data !== undefined && args.data !== null && args.data !== "";
  const hasPath = files !== null && typeof args.path === "string" && args.path.length > 0;
  if (!hasData && !hasPath) return text(importFormatDocument());
  if (hasData && hasPath) return toolError("import_content takes data or path, not both.");

  if (!hasKey(ctx)) return toolError(ctx.notSignedIn());
  if (keyKindOf(ctx) === "publishable") return publishableKeyRefusal(NAME, "articles:write");

  const source = hasPath ? await files!.open(args.path as string) : inlineSource(args.data);
  if ("content" in source) return source;

  const defaultBatch = source.store ? 20 : MAX_INLINE_ARTICLES;
  const batch = Number.isInteger(args.batch_size) ? Math.min(100, Math.max(1, args.batch_size as number)) : defaultBatch;
  try {
    return await runImport(forTool(ctx, NAME), source, {
      dryRun: args.dry_run !== false,
      confirm: args.confirm === true,
      batchSize: batch,
      rehostImages: args.rehost_images !== false,
      publish: args.publish !== false,
      retryFailed: source.store !== null && args.retry_failed === true,
    });
  } catch (err) {
    return toolError(`import_content failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
  }
}
