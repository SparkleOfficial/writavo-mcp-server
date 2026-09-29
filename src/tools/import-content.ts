import { z } from "zod";
import { hasKey, keyKindOf, forTool, type ToolContext } from "../core/context.js";
import { publishableKeyRefusal, text, toolError, type ToolResult } from "../errors.js";
import { IMPORT_FORMAT_SECTIONS, importFormatSection, type ImportFormatSection } from "../import/format.js";
import { runImport, type ImportBudget, type ImportSource } from "../import/engine.js";
import { convertWxr, looksLikeWxr, MAX_WXR_BYTES } from "../import/wordpress/index.js";
import {
  IMPORT_ID_RE,
  JOB_TTL_DAYS,
  MAX_JOB_BYTES,
  UPLOAD_LINK_MINUTES,
  byteLength,
  fetchImportDocument,
  jobSource,
  mergeImportDocuments,
  type BackgroundStatus,
  type ImportJobStore,
} from "../import/jobs.js";
import type { ToolArgs } from "./call.js";

/**
 * Bring an existing blog into Writavo from a document in the Writavo Import Format. The model's
 * job is to produce that document from whatever the source system is; everything that has to be
 * exactly right (matching, idempotency, dates, images, rate limits, resuming) is done here, in
 * code, where it can be tested, rather than left to a model orchestrating a few hundred tool calls.
 *
 * How the document arrives:
 *   - `data`, the document inline, capped per call;
 *   - on the hosted server, every document becomes an IMPORT JOB (src/import/jobs.ts) kept on the
 *     server with its progress: sent inline (in parts if it is big), fetched from an https `url`,
 *     or PUT straight to the server with an `upload` link, and continued with just { import_id }.
 * The host injects job support; the tool itself never touches a filesystem or storage.
 */

/** Per call, for an inline document or part. Past this the document belongs in several parts, a URL or an upload. */
export const MAX_INLINE_ARTICLES = 50;
/**
 * 512 KB, not more: an inline part arrives INSIDE the MCP request, which the hosted Worker must
 * parse before it can hand anything to the import's Durable Object, and a free-plan Worker request
 * gets 10 ms of CPU. A bigger document goes by upload link or url, which never pass through it.
 */
export const MAX_INLINE_BYTES = 512 * 1024;
const INLINE_LIMIT = "512 KB";

interface Capabilities {
  jobs: boolean;
  /** The host can run a stored import to the end on its own (ImportJobStore.startBackground). */
  background: boolean;
}

const NAME = "import_content";
const MB = (bytes: number) => `${bytes / 1024 / 1024} MB`;

function description(can: Capabilities): string {
  const ways = can.jobs
    ? [
        `Give the document one of three ways, and it is kept on the server as an import job with its own progress. Best: if you can run a shell command, call with upload: true for a one-time link and curl the file to it (up to ${MB(MAX_JOB_BYTES)}, never through this conversation). Or an https url the server fetches (a signed storage URL, for example; up to ${MB(MAX_JOB_BYTES)}). Inline data only for a small document: at most ${MAX_INLINE_ARTICLES} articles and ${INLINE_LIMIT} per call (parts after the first carry the import_id the first call returned); anything bigger by upload or url. A WordPress export file (the .xml from Tools > Export) needs no conversion: send it as it is, by upload or url (up to ${MB(MAX_WXR_BYTES)}), and Writavo converts it itself (posts, categories, tags, authors, images, SEO fields, old URLs as redirects).`,
        can.background
          ? "Every call after that is just import_id. An apply (dry_run false) runs IN THE BACKGROUND on the server until it is done, with nobody connected: it returns at once, and import_id with status: true says how far it has got. Check every minute or two; do not call apply again while it runs."
          : "Every call after that is just import_id (plus dry_run, confirm): nothing is sent again.",
      ]
    : [`Give the document inline as data, at most ${MAX_INLINE_ARTICLES} articles and ${INLINE_LIMIT} per call; split a bigger blog across several calls, each carrying the authors, categories and tags its articles use.`];
  return [
    "Import a blog into the Site from a document in the Writavo Import Format: articles with their original slugs and original publish dates, drafts kept as drafts, authors, categories and tags, and images copied into the media library.",
    ...ways,
    can.background
      ? "Runs as a dry run by default, which checks the whole document against the Site, reports every problem in one pass, and writes nothing. An apply (dry_run false) starts the background run and returns at once; call it once, then only check status."
      : "Runs as a dry run by default, which checks the whole document against the Site, reports every problem in one pass, and writes nothing. An apply imports as much as fits in one call (about 20 seconds) and says what is left.",
    "Articles are matched by external_id, so running it again updates rather than duplicates. It never deletes or unpublishes anything.",
    "Applying with publish true makes articles publicly visible on the customer's own live site, so it needs confirm: true, which you pass only after the user has agreed.",
    "Call it with no document to get the format's guide and a sample (short); pass section (schema, engagement, cost_history, redirects, content_types, entries, articles...) for the JSON Schema or one part of the format.",
    "Needs a secret key (wv_sk_) with articles, taxonomy, authors and media write scopes.",
  ].join(" ");
}

function inputSchema(can: Capabilities): Record<string, z.ZodTypeAny> {
  const oneOf = can.jobs ? "Give at most one of data, url or upload." : "";
  return {
    data: z
      .union([z.record(z.unknown()), z.string()])
      .optional()
      .describe(
        `The import document itself, as a JSON object (or its JSON text): { "format": "writavo-import", "version": 1, "articles": [...] }. At most ${MAX_INLINE_ARTICLES} articles and ${INLINE_LIMIT} per call; anything bigger goes by upload: true or url.${can.jobs ? " With import_id, it is added to that import: authors merge on ref, categories and tags on slug, articles on external_id, and an entry with the same key replaces the stored one." : ""} ${oneOf} Omit every document argument to get the format guide and a sample instead (section picks another part).`.trim(),
      ),
    ...(can.jobs
      ? {
          url: z
            .string()
            .optional()
            .describe(`An https URL the server fetches the whole document from, anonymously (a signed storage URL, a raw gist URL). Up to ${MB(MAX_JOB_BYTES)}. With import_id, the fetched document is added to that import.`),
          wordpress_url: z
            .string()
            .optional()
            .describe("A live WordPress site's address (https://example.com): the server reads its posts, categories, tags, authors and SEO fields over the WordPress REST API, read only, and converts them. Published posts only, unless wordpress_username and wordpress_application_password are given. If the site blocks its REST API, use its export file (Tools > Export) by upload instead."),
          wordpress_username: z.string().optional().describe("With wordpress_url: a WordPress user name, to also read drafts, scheduled, pending and private posts."),
          wordpress_application_password: z
            .string()
            .optional()
            .describe("With wordpress_username: an Application Password (WordPress Users > Profile > Application Passwords), never the account password. Held encrypted only while the site is read, then erased. The person should revoke it in WordPress afterwards."),
          upload: z
            .boolean()
            .optional()
            .describe(`true: returns a one-time link and a curl command to PUT the document file straight to the server (up to ${MB(MAX_JOB_BYTES)}, link valid ${UPLOAD_LINK_MINUTES} minutes), without passing it through this conversation. Use it when you can run a shell command. Then call again with the import_id.`),
          import_id: z
            .string()
            .optional()
            .describe(`The import_id a previous call returned (imp_...). Alone, it dry-runs or continues that import from where it stopped. Stored imports are kept ${JOB_TTL_DAYS} days after their last use, for the Site this connection is signed in to (signing in again keeps them).`),
        }
      : {}),
    ...(can.background
      ? {
          background: z
            .boolean()
            .optional()
            .describe("Defaults to true for a stored import: an apply runs on the server until the import is complete, and the call returns at once. false runs one short batch in this call instead."),
          status: z.boolean().optional().describe("With import_id: how far the import has got (and its last report). Reads only."),
          cancel: z.boolean().optional().describe("With import_id: stop a background import after its current batch. What is already imported stays."),
        }
      : {}),
    section: z
      .enum(IMPORT_FORMAT_SECTIONS)
      .optional()
      .describe("With no document: which part of the format to return. Defaults to guide (the format guide and a sample, about 12 KB). schema is the whole JSON Schema (about 90 KB); the others (engagement, cost_history, redirects, content_types, entries, authors, categories, tags, articles) are that part of it with its guide text."),
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
        can.background
          ? "Only with background: false (one foreground batch in this call): how many articles that call imports at most. Defaults to as many as fit in about 20 seconds. Ignored by a background run."
          : "How many articles one call imports at most. Defaults to as many as fit. A call also stops after about 20 seconds, whatever this is.",
      ),
    rehost_images: z
      .boolean()
      .optional()
      .describe("Defaults to true: copy https images (inline, featured, how-to steps, author avatars) into the Site's media library and rewrite their URLs. False keeps every original URL."),
    publish: z
      .boolean()
      .optional()
      .describe("Defaults to true: articles with status published are published with their original dates. False imports everything as a draft and leaves articles already live untouched."),
    ...(can.jobs
      ? {
          retry_failed: z
            .boolean()
            .optional()
            .describe("For a stored import: try again, once, the articles an earlier call skipped or failed, for example after fixing a slug conflict on the Site. Leave it out otherwise."),
        }
      : {}),
  };
}

/** The tool as a host registers it. Job support makes `url`, `upload` and `import_id` appear. */
export function importContentTool(jobs: ImportJobStore | null = null) {
  const can = { jobs: jobs !== null, background: typeof jobs?.startBackground === "function" };
  return {
    name: NAME,
    description: description(can),
    scope: "articles:write",
    inputSchema: inputSchema(can),
  };
}

/** The remote-safe definition, kept for callers that want the name and text without a host. */
export const IMPORT_CONTENT = importContentTool();

/**
 * An inline document or part, parsed and held to the per-call limits. Exported for the hosted
 * import store, which applies the same limits to a part the Worker relays to it unparsed.
 */
export function readInlinePart(data: unknown): { document: unknown; serialised: string } | { error: string } {
  let serialised: string;
  let document: unknown;
  if (typeof data === "string" && looksLikeWxr(data)) {
    // A small WordPress export sent inline: converted here, then held to the same limits.
    const size = byteLength(data);
    if (size > MAX_INLINE_BYTES) {
      return {
        error: `The WordPress export is ${size} bytes, and one call takes at most ${MAX_INLINE_BYTES} (${INLINE_LIMIT}). Nothing was checked or written. Send the .xml file by upload: true (a one-time curl command) or as an https url instead.`,
      };
    }
    const converted = convertWxr(data);
    if ("error" in converted) return { error: converted.error };
    document = converted.document;
    serialised = JSON.stringify(document);
    return { document, serialised };
  }
  if (typeof data === "string") {
    serialised = data;
    try {
      document = JSON.parse(data);
    } catch (err) {
      return { error: `data is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Send the import document as a JSON object.` };
    }
  } else {
    document = data;
    serialised = JSON.stringify(data) ?? "";
  }

  const size = byteLength(serialised);
  if (size > MAX_INLINE_BYTES) {
    return {
      error: `The inline document is ${size} bytes, and one call takes at most ${MAX_INLINE_BYTES} (${INLINE_LIMIT}). Nothing was checked or written. Send it by upload: true (a one-time curl command, up to 10 MB) or as an https url instead; or, without either, split it into parts of at most ${MAX_INLINE_ARTICLES} articles and ${INLINE_LIMIT}, each with the import_id the first part returned.`,
    };
  }
  const articles = (document as { articles?: unknown } | null)?.articles;
  if (Array.isArray(articles) && articles.length > MAX_INLINE_ARTICLES) {
    return {
      error: `The inline document has ${articles.length} articles, and one call takes at most ${MAX_INLINE_ARTICLES}. Nothing was checked or written. Split it into documents of at most ${MAX_INLINE_ARTICLES} articles, each carrying the authors, categories and tags its articles use, and send them one call at a time. Articles are matched by external_id, so the order of the calls does not matter and nothing is duplicated.`,
    };
  }
  return { document, serialised };
}

function parseInline(data: unknown): { document: unknown; serialised: string } | ToolResult {
  const read = readInlinePart(data);
  return "error" in read ? toolError(read.error) : read;
}

function inlineSource(data: unknown): ImportSource | ToolResult {
  const parsed = parseInline(data);
  if ("content" in parsed) return parsed;
  return {
    label: "the inline document",
    document: parsed.document,
    store: null,
    reference: null,
    lease: null,
    defaultBatchSize: MAX_INLINE_ARTICLES,
  };
}

const NO_SUCH_IMPORT = (id: string) =>
  `There is no import ${id} for this connection. Imports are kept ${JOB_TTL_DAYS} days after their last use, and belong to the Site the connection is signed in to (an import started before that rule, or on another Site or with a raw API key, cannot be used here). Send the document again without import_id to start a new import; articles already imported are found again by external_id, so nothing is duplicated.`;

/**
 * The hosted path: turn the call's document argument (if any) into a stored import, merged into
 * the named one when there is an import_id, and hand the engine that import.
 */
async function jobSourceFor(jobs: ImportJobStore, args: { data?: unknown; url?: string; import_id?: string }, hasData: boolean): Promise<ImportSource | ToolResult> {
  const opened = Date.now();
  let part: unknown = undefined;
  if (hasData) {
    const parsed = parseInline(args.data);
    if ("content" in parsed) return parsed;
    part = parsed.document;
  } else if (typeof args.url === "string" && args.url) {
    const fetched = await fetchImportDocument(args.url);
    if ("error" in fetched) return toolError(`Could not read the document at url: ${fetched.error}. Nothing was checked or written.`);
    try {
      part = JSON.parse(fetched.text);
    } catch (err) {
      return toolError(`The document at url is not valid JSON: ${err instanceof Error ? err.message : String(err)}. Nothing was checked or written.`);
    }
  }

  let importId = typeof args.import_id === "string" ? args.import_id.trim() : "";
  let document: unknown;
  if (importId) {
    if (!IMPORT_ID_RE.test(importId)) return toolError(`import_id "${importId.slice(0, 40)}" is not an import id. They look like imp_ followed by 22 characters, exactly as a previous call returned.`);
    const info = await jobs.info(importId);
    if (!info) return toolError(NO_SUCH_IMPORT(importId));
    const storedText = info.status === "ready" ? await jobs.getDocument(importId) : null;
    if (info.status === "ready" && storedText === null) return toolError(NO_SUCH_IMPORT(importId));
    if (part === undefined) {
      if (storedText === null) {
        return toolError(
          `Nothing has been uploaded to the import ${importId} yet. Run the upload command that call returned (it PUTs the file to the server), or call import_content with upload: true and this import_id for a new link.`,
        );
      }
      document = JSON.parse(storedText);
    } else {
      const merged = storedText === null ? part : mergeImportDocuments(JSON.parse(storedText), part);
      if (typeof merged === "string") return toolError(`Could not add to the import ${importId}: ${merged}. Nothing was changed.`);
      const serialised = JSON.stringify(merged);
      if (byteLength(serialised) > MAX_JOB_BYTES) {
        return toolError(
          `With this part the import ${importId} would be ${byteLength(serialised)} bytes, over the ${MB(MAX_JOB_BYTES)} limit for one import. Nothing was changed. Start a second import (without import_id) for the rest of the articles, each carrying the authors, categories and tags its articles use; articles are matched by external_id, so nothing is duplicated.`,
        );
      }
      await jobs.putDocument(importId, serialised);
      document = merged;
    }
  } else {
    const serialised = JSON.stringify(part);
    if (byteLength(serialised) > MAX_JOB_BYTES) {
      return toolError(`The document is ${byteLength(serialised)} bytes, over the ${MB(MAX_JOB_BYTES)} limit for one import. Nothing was checked or written. Split it into two imports, each carrying the authors, categories and tags its articles use.`);
    }
    importId = await jobs.create();
    await jobs.putDocument(importId, serialised);
    document = part;
  }
  return { ...jobSource(jobs, importId, document), openMs: Date.now() - opened };
}

async function uploadLink(jobs: ImportJobStore, importId: string | undefined): Promise<ToolResult> {
  let id = importId?.trim() ?? "";
  if (id) {
    if (!IMPORT_ID_RE.test(id) || !(await jobs.info(id))) return toolError(NO_SUCH_IMPORT(id));
  } else {
    id = await jobs.create();
  }
  const link = await jobs.createUpload(id);
  return text(
    [
      `Import ${id} is waiting for its document. Nothing has been checked or written yet.`,
      "",
      `PUT the import file to the server with this command, replacing the path: a Writavo import document (JSON, up to ${MB(MAX_JOB_BYTES)}) or a WordPress export file as it is (.xml, up to ${MB(MAX_WXR_BYTES)}, converted on the server). The link works once, for ${UPLOAD_LINK_MINUTES} minutes (until ${link.expires_at}). If this import already holds a document, the upload is added to it (entries with the same ref, slug or external_id replace the stored ones).`,
      "",
      `curl -sS --fail-with-body -X PUT -H "Content-Type: application/json" -H "Authorization: Bearer ${link.token}" --data-binary @/absolute/path/to/import.json ${link.url}`,
      "",
      "For a WordPress export, the same command with the .xml file (the Content-Type header does not matter for this link).",
      "",
      "The token in that command is a credential for this upload only: do not show it to anyone else or put it in a file.",
      `When it answers ok, call import_content ${JSON.stringify({ import_id: id })} for the dry run.`,
    ].join("\n"),
  );
}

/**
 * A batch's own report, as a status reply quotes it. The batch ends with how to carry on BY HAND
 * ("Next: call import_content again with the same arguments", then the call), which is right for
 * a foreground batch and wrong here: the background run carries on by itself, and an agent that
 * followed it would start a second apply. Those lines are dropped; the status reply says what to do.
 */
function batchReportForStatus(report: string): string {
  const out: string[] = [];
  const lines = report.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^Next: call import_content again/.test(line)) {
      if (/^import_content \{/.test(lines[i + 1] ?? "")) i += 1;
      continue;
    }
    if (/^(To apply, call:|Then call it again with the same arguments)/.test(line) || /^import_content \{/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A background run's state, for people. */
export function backgroundStatusText(importId: string, st: BackgroundStatus): string {
  const p = st.progress;
  const state: Record<BackgroundStatus["state"], string> = {
    idle: "not started in the background",
    running: "RUNNING in the background",
    complete: "COMPLETE",
    failed: "STOPPED with a problem",
    cancelled: "CANCELLED (a batch already running when it was cancelled still finishes, within about a minute; nothing starts after it)",
    waiting_for_confirm: "WAITING: it would publish, and confirm was not given",
  };
  const lines = [
    `Import ${importId}: ${state[st.state]}.`,
    `Articles ${p.articles_done} of ${p.articles_total} done${p.articles_failed ? `, ${p.articles_failed} failed` : ""}${p.articles_skipped ? `, ${p.articles_skipped} skipped` : ""}. Images copied ${p.images_copied}${p.images_failed ? `, ${p.images_failed} not copied` : ""}. Created: ${p.categories_created} categories, ${p.tags_created} tags, ${p.authors_created} authors.`,
    ...(st.started_at ? [`Started ${st.started_at}; ${st.batches} batch${st.batches === 1 ? "" : "es"} so far; last update ${st.updated_at}${st.finished_at ? `; finished ${st.finished_at}` : ""}.`] : []),
    ...(st.error ? ["", `Why it stopped: ${st.error}`] : []),
    ...(st.last_report ? ["", "Last batch:", batchReportForStatus(st.last_report)] : []),
    "",
    st.state === "running"
      ? `Check again in a minute or two with import_content ${JSON.stringify({ import_id: importId, status: true })}. Do not start it again; it carries on by itself.`
      : st.state === "complete"
        ? "Next: verify with list_articles that the counts, slugs and dates match the source."
        : st.state === "idle"
          ? `Start it with import_content ${JSON.stringify({ import_id: importId, dry_run: false })} (add confirm: true only if the user agreed to publish).`
          : `Fix the cause, then start it again with import_content ${JSON.stringify({ import_id: importId, dry_run: false })}: it carries on where it stopped.`,
  ];
  return lines.join("\n");
}

type ApplyArgs = { dry_run?: boolean; background?: boolean; publish?: boolean; confirm?: boolean; rehost_images?: boolean; retry_failed?: boolean };

/**
 * An apply of a stored import: in the background when the host can run one, which is the default.
 * Null when this call should run a foreground batch instead (background: false and not running).
 */
async function applyInBackground(runner: ImportJobStore, importId: string, args: ApplyArgs, ctx: ToolContext): Promise<ToolResult | null> {
  const current = await runner.status!(importId);
  if (current?.state === "running") return text(backgroundStatusText(importId, current));
  if (args.background === false) return null;
  const publish = args.publish !== false;
  if (publish && args.confirm !== true) {
    return text(
      [
        "Nothing has been done. A background import may publish articles on the customer's live site with their original dates, so it needs confirm: true, which you pass only after the user has agreed.",
        `If they agree, call import_content ${JSON.stringify({ import_id: importId, dry_run: false, confirm: true })}.`,
        `To import everything as drafts instead, with nothing made public: import_content ${JSON.stringify({ import_id: importId, dry_run: false, publish: false })}.`,
      ].join("\n"),
    );
  }
  const st = await runner.startBackground!(importId, {
    apiKey: ctx.apiKey(),
    publish,
    confirm: args.confirm === true,
    rehost_images: args.rehost_images !== false,
    retry_failed: args.retry_failed === true,
  });
  return text(
    [
      `Started import ${importId} in the background on Writavo's server. It runs until every article is done, at the fastest pace the API's rate limits allow, with nobody connected; this conversation can end.`,
      "",
      backgroundStatusText(importId, st),
    ].join("\n"),
  );
}

export async function handleImportContent(
  ctx: ToolContext,
  rawArgs: ToolArgs,
  jobs: ImportJobStore | null = null,
  budget?: ImportBudget,
): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as {
    data?: unknown;
    url?: string;
    upload?: boolean;
    import_id?: string;
    dry_run?: boolean;
    confirm?: boolean;
    batch_size?: number;
    rehost_images?: boolean;
    publish?: boolean;
    retry_failed?: boolean;
    background?: boolean;
    status?: boolean;
    cancel?: boolean;
    section?: string;
    wordpress_url?: string;
    wordpress_username?: string;
    wordpress_application_password?: string;
  };

  const startedAt = Date.now();
  const hasData = args.data !== undefined && args.data !== null && args.data !== "";
  const hasUrl = jobs !== null && typeof args.url === "string" && args.url.length > 0;
  const wantsUpload = jobs !== null && args.upload === true;
  const hasWp = jobs !== null && typeof args.wordpress_url === "string" && args.wordpress_url.length > 0;
  const hasId = jobs !== null && typeof args.import_id === "string" && args.import_id.length > 0;
  const given = [hasData, hasUrl, wantsUpload, hasWp].filter(Boolean).length;
  if (given === 0 && !hasId) return text(importFormatSection(args.section as ImportFormatSection | undefined));
  if (given > 1) return toolError("import_content takes one of data, url, upload or wordpress_url per call, not several.");
  if (hasWp && Boolean(args.wordpress_username) !== Boolean(args.wordpress_application_password)) {
    return toolError("Give wordpress_username and wordpress_application_password together, or neither (published posts only).");
  }

  if (!hasKey(ctx)) return toolError(ctx.notSignedIn());
  if (keyKindOf(ctx) === "publishable") return publishableKeyRefusal(NAME, "articles:write");

  // Status and cancel read or stop a background run; they send no document and touch no article.
  const runner = jobs && jobs.startBackground && jobs.status && jobs.cancel ? jobs : null;
  if ((args.status === true || args.cancel === true) && hasId && given === 0 && runner) {
    const id = args.import_id!.trim();
    if (!IMPORT_ID_RE.test(id)) return toolError(NO_SUCH_IMPORT(id.slice(0, 40)));
    try {
      const st = args.cancel === true ? await runner.cancel!(id) : await runner.status!(id);
      return st ? text(backgroundStatusText(id, st)) : toolError(NO_SUCH_IMPORT(id));
    } catch (err) {
      return toolError(`import_content could not reach its import storage: ${err instanceof Error ? err.message : String(err)}. Try again in a moment.`);
    }
  }

  // THE HOSTED PATH. When the store can do the document work itself (the Durable Object), the
  // Worker never parses a stored document: it relays the part or the URL, starts the background
  // run or asks the store for one call's worth, and passes the reply on. On the free Workers plan
  // a request gets 10 ms of CPU, and checking a 4 MB import takes far more (Cloudflare 1102).
  const remote = jobs && jobs.runStored && jobs.addPart && jobs.addFromUrl ? jobs : null;
  if (remote && !wantsUpload) {
    try {
      let id = hasId ? args.import_id!.trim() : "";
      if (id && !IMPORT_ID_RE.test(id)) {
        return toolError(`import_id "${id.slice(0, 40)}" is not an import id. They look like imp_ followed by 22 characters, exactly as a previous call returned.`);
      }
      let converting = false;
      if (id) {
        const info = await remote.info(id);
        if (!info) return toolError(NO_SUCH_IMPORT(id));
        // A WordPress export or site still being read or converted: the store's reply says how far.
        converting = info.conversion !== undefined && info.conversion.state !== "failed";
        if (info.status !== "ready" && !hasData && !hasUrl && !hasWp && info.conversion === undefined) {
          return toolError(
            `Nothing has been uploaded to the import ${id} yet. Run the upload command that call returned (it PUTs the file to the server), or call import_content with upload: true and this import_id for a new link.`,
          );
        }
      }
      if (hasWp && !remote.addFromWordPress) return toolError("This server cannot read a WordPress site directly. Export a file from Tools > Export and send it by upload: true instead.");
      if (hasData || hasUrl || hasWp) {
        if (!id) id = await remote.create();
        const added = hasData
          ? await remote.addPart!(id, args.data)
          : hasWp
            ? await remote.addFromWordPress!(id, {
                url: args.wordpress_url!,
                ...(args.wordpress_username ? { username: args.wordpress_username, applicationPassword: args.wordpress_application_password! } : {}),
              })
            : await remote.addFromUrl!(id, args.url!);
        if (!added.ok) return toolError(added.error);
        converting = added.converting === true;
      }
      if (args.dry_run === false && runner && !converting) {
        const started = await applyInBackground(runner, id, args, ctx);
        if (started) return started;
      }
      const out = await remote.runStored!(id, {
        apiKey: ctx.apiKey(),
        dryRun: args.dry_run !== false,
        confirm: args.confirm === true,
        publish: args.publish !== false,
        rehostImages: args.rehost_images !== false,
        retryFailed: args.retry_failed === true,
        ...(Number.isInteger(args.batch_size) ? { batchSize: Math.min(100, Math.max(1, args.batch_size as number)) } : {}),
      });
      return out.isError ? toolError(out.text) : text(out.text);
    } catch (err) {
      return toolError(`import_content could not reach its import storage: ${err instanceof Error ? err.message : String(err)}. Try again in a moment.`);
    }
  }

  let source: ImportSource | ToolResult;
  try {
    if (wantsUpload) return await uploadLink(jobs!, args.import_id);
    source = jobs ? await jobSourceFor(jobs, args, hasData) : inlineSource(args.data);
  } catch (err) {
    return toolError(`import_content could not reach its import storage: ${err instanceof Error ? err.message : String(err)}. Nothing was written. Try again in a moment.`);
  }
  if ("content" in source) return source;

  // An apply of a stored import runs in the background by default, when the host can.
  const importId = typeof source.reference?.import_id === "string" ? source.reference.import_id : null;
  if (runner && importId && args.dry_run === false) {
    try {
      const started = await applyInBackground(runner, importId, args, ctx);
      if (started) return started;
    } catch (err) {
      return toolError(`import_content could not start the background import: ${err instanceof Error ? err.message : String(err)}. Nothing was written. Try again in a moment, or pass background: false to run one batch in this call.`);
    }
  }

  const batch = Number.isInteger(args.batch_size) ? Math.min(100, Math.max(1, args.batch_size as number)) : source.defaultBatchSize;
  try {
    return await runImport(forTool(ctx, NAME), source, {
      startedAt,
      ...(budget ? { budget } : {}),
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
