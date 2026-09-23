import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { WritavoApiError } from "../api/client.js";
import { MediaError, fetchImage, uploadImage } from "../api/media.js";
import { formatApiError, text, toolError, type ToolResult } from "../errors.js";
import type { ImportArticle, ImportEnvelope } from "./format.js";
import { articleImages, htmlImageCount, isHttps, rewriteMarkdownImages } from "./images.js";
import {
  newProgress,
  progressPath,
  readProgress,
  writeProgress,
  type ImportProgress,
  type ProgressItem,
} from "./progress.js";
import {
  ARTICLE_STATE_FIELDS,
  call,
  findByExternalId,
  findBySlug,
  getArticleState,
  getSite,
  isTransient,
  listAll,
  type SiteArticle,
  type SiteAuthor,
  type SiteContentType,
  type SiteInfo,
  type SiteTerm,
} from "./site.js";
import { checkDocument, itemLabel, type ItemCheck } from "./validate.js";

/**
 * The importer. One tool call is either a dry run (reads only, writes nothing, not even the
 * progress file) or one batch of an apply. An apply is resumable and idempotent at every step:
 *
 *   - taxonomy is matched by slug (authors by exact name) before anything is created;
 *   - an article is found by external_id before it is written, and created with an
 *     Idempotency-Key derived from its external_id and its exact body, so a retried create
 *     replays rather than duplicates;
 *   - original dates go through the publish verb, which honours them on a first publish only
 *     and accepts the identical value again, so a retried publish is a no-op;
 *   - what is done is recorded in <file>.writavo-progress.json after every article.
 *
 * Nothing is ever deleted or unpublished, and nothing in the customer's prose is rewritten except
 * the URLs of images that were copied into the media library.
 */

export interface ImportOptions {
  filePath: string;
  dryRun: boolean;
  confirm: boolean;
  batchSize: number;
  rehostImages: boolean;
  publish: boolean;
  retryFailed: boolean;
}

/** Per key, per minute (contract section 2b). Used for the dry run's estimate only. */
const RATE = { read: 600, write: 120, upload: 60 };
/** Stop starting new work after this long, well inside the 60 second request timeout MCP clients default to. */
const TIME_BUDGET_MS = 35_000;
/** How many problems a reply lists before summarising the rest. */
const MAX_LISTED = 40;

/** Codes that no retry and no other article can get past. The run stops and says so. */
const FATAL_CODES = new Set([
  "INVALID_API_KEY",
  "API_KEY_REVOKED",
  "API_KEY_EXPIRED",
  "INSUFFICIENT_SCOPE",
  "PAYMENT_METHOD_REQUIRED",
]);

const isFatal = (err: unknown): err is WritavoApiError => err instanceof WritavoApiError && FATAL_CODES.has(err.code);

class ItemProblem extends Error {}

interface ValidItem {
  check: ItemCheck;
  article: ImportArticle;
  hash: string;
}

interface Loaded {
  envelope: ImportEnvelope;
  items: ItemCheck[];
  valid: ValidItem[];
  site: SiteInfo;
  progress: ImportProgress;
  progressFile: string;
  progressExisted: boolean;
  siteCategories: Map<string, string>;
  siteTags: Map<string, string>;
  siteAuthors: Map<string, string>;
  formats: Map<string, string>;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function apiProblem(err: unknown): string {
  if (err instanceof WritavoApiError) {
    const fields = err.fields ? ` (${Object.entries(err.fields).map(([f, m]) => `${f}: ${m}`).join("; ")})` : "";
    return `${err.code}: ${err.message}${fields}`;
  }
  return err instanceof Error ? err.message : String(err);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function listed(lines: string[], cap = MAX_LISTED): string[] {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `- and ${lines.length - cap} more`];
}

/** Whether an item needs nothing more under the options of this call. */
function isSettled(entry: ProgressItem | undefined, item: ValidItem, opts: ImportOptions, mayTouchLive: boolean): boolean {
  if (!entry || entry.hash !== item.hash) return false;
  switch (entry.outcome) {
    case "done":
      return !(item.article.status === "published" && opts.publish) || entry.published === true;
    case "deferred":
      return !mayTouchLive;
    case "skipped":
    case "failed":
      return !opts.retryFailed;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Loading: the file, the Site, and the checks that need both
// ---------------------------------------------------------------------------
async function load(opts: ImportOptions): Promise<Loaded | ToolResult> {
  if (!isAbsolute(opts.filePath)) {
    return toolError("import_content needs an absolute file_path, so there is no ambiguity about which file is meant.");
  }
  let raw: string;
  try {
    raw = await readFile(opts.filePath, "utf8");
  } catch (err) {
    return toolError(`Cannot read ${opts.filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return toolError(`${opts.filePath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  const checked = checkDocument(value);
  if (!checked.envelope || checked.envelopeErrors.length > 0) {
    return toolError(
      [
        `${opts.filePath} is not a valid Writavo import document, so nothing was checked against the Site and nothing was written.`,
        "",
        ...listed(checked.envelopeErrors.map((e) => `- ${e}`)),
        "",
        "Read the resource writavo://import-format, or call import_content with no file_path, for the format.",
      ].join("\n"),
    );
  }
  const envelope = checked.envelope;

  let site: SiteInfo;
  let siteCategories: Map<string, string>;
  let siteTags: Map<string, string>;
  let siteAuthors: Map<string, string>;
  let formats: Map<string, string>;
  try {
    site = await getSite();
    const [categories, tags, authors, types] = await Promise.all([
      listAll<SiteTerm>("/categories", [["fields", "id,name,slug"]]),
      listAll<SiteTerm>("/tags", [["fields", "id,name,slug"]]),
      listAll<SiteAuthor>("/authors", [["fields", "id,name"]]),
      call<{ items: SiteContentType[] }>({ method: "GET", path: "/content-types" }),
    ]);
    siteCategories = new Map(categories.map((c) => [c.slug, c.id]));
    siteTags = new Map(tags.map((t) => [t.slug, t.id]));
    siteAuthors = new Map();
    for (const a of authors) if (!siteAuthors.has(a.name)) siteAuthors.set(a.name, a.id);
    formats = new Map();
    for (const t of types.data?.items ?? []) if (t.is_active !== false || !formats.has(t.key)) formats.set(t.key, t.id);
  } catch (err) {
    return formatApiError(err, { tool: "import_content" });
  }

  const progressFile = progressPath(opts.filePath);
  const existing = readProgress(progressFile);
  if (typeof existing === "string") {
    return toolError(
      `The progress file ${progressFile} cannot be used because ${existing}. Move it aside to start the import over; articles already imported are found again by external_id, so nothing is duplicated.`,
    );
  }
  if (existing && existing.website_id !== site.id) {
    return toolError(
      `The progress file ${progressFile} belongs to an import into a different Site ("${existing.website_name}"). This key is for "${site.name}". If importing into "${site.name}" is intended, move the progress file aside and run again; otherwise sign in to the right Site (login with force: true).`,
    );
  }
  const progress = existing ?? newProgress(opts.filePath, site);

  // Checks that need the Site: every reference must resolve to something that exists or will.
  const fileCategories = new Set((envelope.categories ?? []).map((c) => c.slug));
  const fileTags = new Set((envelope.tags ?? []).map((t) => t.slug));
  const valid: ValidItem[] = [];
  for (const item of checked.items) {
    const article = item.article;
    if (!article) continue;
    if (article.category !== undefined && !fileCategories.has(article.category) && !siteCategories.has(article.category)) {
      item.errors.push(`category: "${article.category}" is not in categories[] and not on the Site`);
    }
    for (const tag of article.tags ?? []) {
      if (!fileTags.has(tag) && !siteTags.has(tag)) item.errors.push(`tags: "${tag}" is not in tags[] and not on the Site`);
    }
    if (article.format !== undefined && !formats.has(article.format)) {
      item.errors.push(
        `format: "${article.format}" is not a content type on this Site. Known keys: ${[...formats.keys()].join(", ") || "none"}. Leave format out if unsure.`,
      );
    }
    if (item.errors.length === 0) valid.push({ check: item, article, hash: sha256(JSON.stringify(article)) });
  }

  return {
    envelope,
    items: checked.items,
    valid,
    site,
    progress,
    progressFile,
    progressExisted: existing !== null,
    siteCategories,
    siteTags,
    siteAuthors,
    formats,
  };
}

function nextCall(opts: ImportOptions, overrides: Record<string, unknown>): string {
  const args: Record<string, unknown> = { file_path: opts.filePath, dry_run: false };
  if (!opts.publish) args.publish = false;
  if (!opts.rehostImages) args.rehost_images = false;
  if (opts.batchSize !== 20) args.batch_size = opts.batchSize;
  Object.assign(args, overrides);
  return `import_content ${JSON.stringify(args)}`;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------
async function dryRun(opts: ImportOptions, ctx: Loaded): Promise<ToolResult> {
  const { envelope, valid, progress, site } = ctx;

  let index: SiteArticle[];
  try {
    index = await listAll<SiteArticle>("/articles", [["fields", ARTICLE_STATE_FIELDS]]);
  } catch (err) {
    return formatApiError(err, { tool: "import_content" });
  }
  if (index.length > 0 && !index.every((a) => "external_id" in a)) {
    return toolError(
      "The Writavo API did not return external_id on articles, which the importer needs so that a second run updates instead of duplicating. Nothing was written. This needs a newer API; contact support if it persists.",
    );
  }
  const byExternalId = new Map<string, SiteArticle>();
  const bySlug = new Map<string, SiteArticle>();
  for (const a of index) {
    if (a.external_id) byExternalId.set(a.external_id, a);
    if (a.slug) bySlug.set(a.slug, a);
  }

  const mayTouchLive = opts.publish;
  const counts = { create: 0, update: 0, done: 0, unchangedLive: 0, publish: 0, blocked: 0 };
  const warnings: string[] = [];
  const pending: ValidItem[] = [];

  for (const item of valid) {
    const { article } = item;
    const label = itemLabel(item.check);
    for (const w of item.check.warnings) warnings.push(`- ${label}: ${w}`);
    if (isSettled(progress.items[article.external_id], item, opts, mayTouchLive)) {
      counts.done += 1;
      continue;
    }
    const existing = byExternalId.get(article.external_id);
    if (existing) {
      if (existing.status === "published" && !opts.publish) {
        counts.unchangedLive += 1;
        warnings.push(`- ${label}: is live on the Site, so it is left unchanged while publish is false`);
        continue;
      }
      counts.update += 1;
      if (existing.status === "published" && article.slug && existing.slug && existing.slug !== article.slug) {
        warnings.push(`- ${label}: its live URL changes from /${existing.slug} to /${article.slug}, and nothing redirects the old one`);
      }
    } else {
      const owner = article.slug ? bySlug.get(article.slug) : undefined;
      if (owner) {
        item.check.errors.push(
          `slug: "${article.slug}" is already used on the Site by article ${owner.id}${owner.external_id ? ` (external_id ${owner.external_id})` : ", which has no external_id"}`,
        );
        continue;
      }
      counts.create += 1;
    }
    if (article.status === "published" && opts.publish) {
      if (existing?.status === "published") {
        if (existing.published_at && article.published_at && Date.parse(existing.published_at) !== Date.parse(article.published_at)) {
          warnings.push(`- ${label}: is already published on the Site since ${existing.published_at}; it keeps that date (the file says ${article.published_at})`);
        }
      } else {
        counts.publish += 1;
      }
    }
    pending.push(item);
  }

  // Images, counted once per URL across the whole import, as they will be copied.
  const toCopy = new Set<string>();
  const notHttps = new Set<string>();
  let htmlImages = 0;
  const consider = (url: string) => {
    if (!isHttps(url)) notHttps.add(url);
    else if (!progress.images[url]) toCopy.add(url);
  };
  for (const item of pending) {
    for (const image of articleImages(item.article)) consider(image.url);
    htmlImages += htmlImageCount(item.article.content);
  }
  const authorsToCreate = (envelope.authors ?? []).filter((a) => !ctx.siteAuthors.has(a.name));
  for (const a of authorsToCreate) if (a.avatar_url) consider(a.avatar_url);
  const categoriesToCreate = (envelope.categories ?? []).filter((c) => !ctx.siteCategories.has(c.slug));
  const tagsToCreate = (envelope.tags ?? []).filter((t) => !ctx.siteTags.has(t.slug));

  let documents = "";
  try {
    const usage = await call<{ limits?: { key: string; limit: number | null; used: number }[] }>({ method: "GET", path: "/usage" });
    const row = usage.data?.limits?.find((l) => l.key === "documents");
    if (row) {
      const after = row.used + counts.create;
      documents =
        row.limit === null
          ? `Documents: ${row.used} stored; this import adds ${counts.create}. No allowance applies.`
          : `Documents: ${row.used} of ${row.limit} included used; this import adds ${counts.create}, for ${after}.` +
            (after > row.limit
              ? " That goes past the included allowance. Documents are pay-as-you-go on every plan, so the overage is billed rather than blocked, but that needs a payment method on file. Without one, creates past the allowance are refused with PAYMENT_METHOD_REQUIRED. Nothing already published stops serving either way."
              : "");
    }
  } catch (err) {
    documents = `Documents: the allowance could not be read (${apiProblem(err)}).`;
  }

  // The estimate is the bottleneck bucket: reads, writes and uploads are limited separately.
  const reads = pending.length * 2 + 10;
  const writes = categoriesToCreate.length + tagsToCreate.length + authorsToCreate.length + pending.length + counts.publish;
  const uploads = (opts.rehostImages ? toCopy.size : 0) * 2;
  const minutes = Math.max(1, Math.ceil(Math.max(reads / RATE.read, writes / RATE.write, uploads / RATE.upload)));
  const calls = Math.max(1, Math.ceil(pending.length / opts.batchSize));

  const invalid = ctx.items.filter((i) => i.errors.length > 0);
  counts.blocked = invalid.length;
  const published = valid.filter((v) => v.article.status === "published").length;

  const lines = [
    `Dry run of ${opts.filePath} for the Site "${site.name}". Nothing was written.`,
    "",
    `Articles in the file: ${ctx.items.length} (${published} published, ${plural(valid.length - published, "draft")}${invalid.length ? `, ${invalid.length} with problems` : ""}).`,
    `- create: ${counts.create}`,
    `- update: ${counts.update} (already on the Site with the same external_id)`,
    ...(counts.done ? [`- already done by an earlier run: ${counts.done}`] : []),
    ...(counts.unchangedLive ? [`- left unchanged because they are live and publish is false: ${counts.unchangedLive}`] : []),
    `- blocked by a problem below: ${counts.blocked}`,
    opts.publish
      ? `- to publish with their original dates: ${counts.publish}`
      : "- to publish: none, because publish is false (everything is imported as a draft)",
    "",
    `Categories: ${(envelope.categories ?? []).length} in the file, ${categoriesToCreate.length} to create. Tags: ${(envelope.tags ?? []).length} in the file, ${tagsToCreate.length} to create. Authors: ${(envelope.authors ?? []).length} in the file, ${authorsToCreate.length} to create (matched by exact name).`,
    opts.rehostImages
      ? `Images to copy into the media library: ${toCopy.size}.${notHttps.size ? ` Not https, so kept at their original URLs: ${notHttps.size}.` : ""}`
      : `Images: not copied (rehost_images is false); ${toCopy.size + notHttps.size} keep their original URLs.`,
    ...(htmlImages
      ? [`${htmlImages} images are HTML <img> tags inside content. Only markdown images are copied, so those keep their original URLs; convert them to ![alt](url) in the file to have them copied.`]
      : []),
    documents,
    `Estimate: about ${reads} reads, ${writes} writes and ${uploads} upload calls, so at least ${minutes} minute${minutes === 1 ? "" : "s"} at the API's rate limits (${RATE.read} reads, ${RATE.write} writes, ${RATE.upload} uploads per minute), over about ${calls} call${calls === 1 ? "" : "s"} of import_content at batch_size ${opts.batchSize}.`,
  ];
  if (ctx.progressExisted) lines.push(`Progress from an earlier run is in ${ctx.progressFile}.`);

  if (invalid.length > 0) {
    lines.push("", `Problems (${invalid.length} articles). These are not imported until fixed:`);
    lines.push(...listed(invalid.map((i) => `- ${itemLabel(i)}: ${i.errors.join("; ")}`)));
  }
  if (warnings.length > 0) lines.push("", `Warnings (${warnings.length}). These do not stop the import:`, ...listed(warnings));

  lines.push("");
  if (pending.length === 0) {
    lines.push(invalid.length > 0 ? "Nothing else to import. Fix the problems above and run the dry run again." : "Nothing to import: everything in the file is already on the Site.");
  } else {
    const needsConfirm = opts.publish && pending.some((p) => p.article.status === "published");
    if (invalid.length > 0) {
      lines.push("Fix the problems above in the file and run the dry run again. Or apply now: the articles with problems are skipped and reported, and everything else is imported.");
    }
    lines.push(
      needsConfirm
        ? `To apply, first ask the user: this publishes ${plural(counts.publish, "article")} on their live site with their original dates${counts.update ? `, and updates to articles already live take effect immediately` : ""}. If they agree, call:`
        : "To apply, call:",
      nextCall(opts, needsConfirm ? { confirm: true } : {}),
      "Then call it again with the same arguments until it reports the import is complete.",
    );
  }
  return text(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------
interface ApplyState {
  opts: ImportOptions;
  ctx: Loaded;
  deadline: number;
  mayTouchLive: boolean;
  counts: { created: number; updated: number; published: number; deferred: number; skipped: number; failed: number; imagesCopied: number; imagesFailed: number };
  problems: string[];
  warnings: string[];
}

function save(state: ApplyState): void {
  writeProgress(state.ctx.progressFile, state.ctx.progress);
}

/** Copy one image, once per import. Undefined means keep the original URL. */
async function rehost(state: ApplyState, url: string, alt: string | undefined, bucket: "blog-images" | "author-avatars", warnings: string[]): Promise<string | undefined> {
  const { progress } = state.ctx;
  if (!isHttps(url)) {
    warnings.push(`image ${url} is not https, so it keeps its original URL`);
    return undefined;
  }
  const known = progress.images[url];
  if (known?.url) return known.url;
  if (known?.error) return undefined;
  try {
    // Bounded by the call's budget, so one slow image host cannot hold a call open for minutes.
    const fetched = await fetchImage(url, undefined, Math.max(5_000, Math.min(30_000, state.deadline + 20_000 - Date.now())));
    if (!fetched.contentType) throw new MediaError("it is not one of the accepted image types");
    const asset = await retrying(state, () =>
      uploadImage({ bytes: fetched.bytes, fileName: fetched.fileName, contentType: fetched.contentType!, altText: alt || undefined, bucket }),
    );
    const hosted = typeof asset.url === "string" ? asset.url : "";
    if (!hosted) throw new MediaError("the media library returned no URL");
    progress.images[url] = { url: hosted };
    state.counts.imagesCopied += 1;
    return hosted;
  } catch (err) {
    if (isTransient(err) || isFatal(err)) throw err;
    const reason = err instanceof MediaError ? err.message : apiProblem(err);
    progress.images[url] = { error: reason };
    state.counts.imagesFailed += 1;
    warnings.push(`image ${url} was not copied (${reason}), so it keeps its original URL`);
    return undefined;
  }
}

/** The same patience site.call gives, for the upload handshake, which makes its own requests. */
async function retrying<T>(state: ApplyState, run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isTransient(err) || attempt >= 3) throw err;
      const retryAfter = err instanceof WritavoApiError && err.retryAfter ? Number.parseInt(err.retryAfter, 10) * 1000 : NaN;
      const wait = Math.min(Number.isFinite(retryAfter) ? retryAfter : 2_000 * 2 ** attempt, 30_000);
      if (Date.now() + wait > state.deadline + 20_000) throw err;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function ensureTaxonomy(state: ApplyState): Promise<boolean> {
  const { ctx, opts } = state;
  const { progress, envelope } = ctx;

  const terms: { kind: "categories" | "tags"; site: Map<string, string>; list: { slug: string; name: string }[] }[] = [
    { kind: "categories", site: ctx.siteCategories, list: envelope.categories ?? [] },
    { kind: "tags", site: ctx.siteTags, list: envelope.tags ?? [] },
  ];
  for (const { kind, site, list } of terms) {
    for (const term of list) {
      const known = site.get(term.slug);
      if (known) {
        progress[kind][term.slug] = known;
        continue;
      }
      if (Date.now() > state.deadline) return false;
      const body = { name: term.name, slug: term.slug };
      let id: string | undefined;
      try {
        const created = await call<{ id: string }>(
          { method: "POST", path: `/${kind}`, body, headers: { "Idempotency-Key": `import-${kind}-${sha256(JSON.stringify(body))}` } },
          state.deadline + 20_000,
        );
        id = created.data?.id;
        progress.created[kind] += 1;
      } catch (err) {
        if (!(err instanceof WritavoApiError && err.code === "SLUG_CONFLICT")) throw err;
        // Created meanwhile, by someone else or by an earlier call that did not get to record it.
        const all = await listAll<SiteTerm>(`/${kind}`, [["fields", "id,name,slug"]]);
        id = all.find((t) => t.slug === term.slug)?.id;
      }
      if (!id) throw new ItemProblem(`the ${kind === "categories" ? "category" : "tag"} "${term.slug}" could not be created`);
      site.set(term.slug, id);
      progress[kind][term.slug] = id;
      save(state);
    }
  }

  for (const author of envelope.authors ?? []) {
    const known = ctx.siteAuthors.get(author.name);
    if (known) {
      progress.authors[author.ref] = known;
      continue;
    }
    if (Date.now() > state.deadline) return false;
    const warnings: string[] = [];
    let avatar = author.avatar_url ?? null;
    if (avatar && opts.rehostImages) avatar = (await rehost(state, avatar, author.name, "author-avatars", warnings)) ?? avatar;
    for (const w of warnings) state.warnings.push(`- author ${author.ref}: ${w}`);
    const body = {
      name: author.name,
      ...(author.bio !== undefined ? { bio: author.bio } : {}),
      ...(avatar ? { avatar_url: avatar } : {}),
      is_ai_generated: author.is_ai_generated ?? false,
      is_default: false,
    };
    const created = await call<{ id: string }>(
      { method: "POST", path: "/authors", body, headers: { "Idempotency-Key": `import-author-${sha256(JSON.stringify(body))}` } },
      state.deadline + 20_000,
    );
    if (!created.data?.id) throw new ItemProblem(`the author "${author.name}" could not be created`);
    ctx.siteAuthors.set(author.name, created.data.id);
    progress.authors[author.ref] = created.data.id;
    progress.created.authors += 1;
    save(state);
  }
  return true;
}

function buildBody(article: ImportArticle, ctx: Loaded, imageUrl: (url: string) => string | undefined): Record<string, unknown> {
  const { progress, envelope } = ctx;
  const body: Record<string, unknown> = { external_id: article.external_id };
  if (article.title !== undefined) body.title = article.title;
  if (article.slug !== undefined) body.slug = article.slug;
  if (article.content !== undefined) {
    body.content = article.content === null ? null : rewriteMarkdownImages(article.content, imageUrl);
  }
  if (article.excerpt !== undefined) body.excerpt = article.excerpt;
  if (article.featured_image !== undefined) {
    body.featured_image_url = article.featured_image === null ? null : (imageUrl(article.featured_image.url) ?? article.featured_image.url);
  }
  if (article.seo_title !== undefined) body.seo_title = article.seo_title;
  if (article.seo_description !== undefined) body.seo_description = article.seo_description;
  if (article.seo_keywords !== undefined) body.seo_keywords = article.seo_keywords;
  if (article.faqs !== undefined) body.faqs = article.faqs;
  if (article.key_takeaways !== undefined) body.key_takeaways = article.key_takeaways;
  if (article.howto_steps !== undefined) {
    body.howto_steps =
      article.howto_steps === null
        ? null
        : article.howto_steps.map((step) => (step.image_url ? { ...step, image_url: imageUrl(step.image_url) ?? step.image_url } : step));
  }
  if (article.comparison !== undefined) body.comparison = article.comparison;

  if (article.category !== undefined) {
    const id = progress.categories[article.category] ?? ctx.siteCategories.get(article.category);
    if (!id) throw new ItemProblem(`category "${article.category}" is not on the Site`);
    body.category_id = id;
  }
  if (article.author !== undefined) {
    const name = (envelope.authors ?? []).find((a) => a.ref === article.author)?.name;
    const id = progress.authors[article.author] ?? (name ? ctx.siteAuthors.get(name) : undefined);
    if (!id) throw new ItemProblem(`author "${article.author}" is not on the Site`);
    body.author_id = id;
  }
  if (article.format !== undefined) {
    const id = ctx.formats.get(article.format);
    if (!id) throw new ItemProblem(`format "${article.format}" is not on the Site`);
    body.format_id = id;
  }
  if (article.tags !== undefined) {
    body.tag_ids = article.tags.map((slug) => {
      const id = progress.tags[slug] ?? ctx.siteTags.get(slug);
      if (!id) throw new ItemProblem(`tag "${slug}" is not on the Site`);
      return id;
    });
  }
  return body;
}

function record(state: ApplyState, item: ValidItem, patch: Partial<ProgressItem> & Pick<ProgressItem, "outcome">): void {
  const { progress } = state.ctx;
  const previous = progress.items[item.article.external_id];
  const base = previous && previous.hash === item.hash ? previous : undefined;
  progress.items[item.article.external_id] = {
    ...(base ?? {}),
    ...patch,
    hash: item.hash,
    updated_at: new Date().toISOString(),
  };
}

async function processArticle(state: ApplyState, item: ValidItem): Promise<void> {
  const { ctx, opts } = state;
  const { article } = item;
  const label = itemLabel(item.check);
  const previous = ctx.progress.items[article.external_id];
  const needsPublish = article.status === "published" && opts.publish;
  const warnings: string[] = [...item.check.warnings];

  let articleId = previous && previous.hash === item.hash && previous.action ? previous.article_id : undefined;
  let current: SiteArticle | null = null;

  if (!articleId) {
    if (opts.rehostImages) {
      for (const image of articleImages(article)) await rehost(state, image.url, image.alt, "blog-images", warnings);
      save(state);
    }
    const body = buildBody(article, ctx, (url) => (opts.rehostImages ? ctx.progress.images[url]?.url : undefined));

    current = await findByExternalId(article.external_id, state.deadline + 20_000);
    let action: "created" | "updated";
    if (current) {
      if (current.status === "published" && !state.mayTouchLive) {
        record(state, item, {
          outcome: "deferred",
          article_id: current.id,
          error: opts.publish
            ? "live on the Site, so it was left unchanged; updating live content needs confirm: true"
            : "live on the Site, so it was left unchanged while publish is false",
        });
        state.counts.deferred += 1;
        return;
      }
      if (current.status === "published" && article.slug && current.slug && current.slug !== article.slug) {
        warnings.push(`its live URL changed from /${current.slug} to /${article.slug}; nothing redirects the old one`);
      }
      await call({ method: "PATCH", path: `/articles/${encodeURIComponent(current.id)}`, body }, state.deadline + 20_000);
      articleId = current.id;
      action = "updated";
      state.counts.updated += 1;
    } else {
      try {
        const created = await call<SiteArticle>(
          {
            method: "POST",
            path: "/articles",
            body,
            // Derived, not random: the same article with the same body always sends the same key,
            // so a create that timed out and is sent again is replayed by the API, not repeated.
            headers: { "Idempotency-Key": `import-${sha256(`${article.external_id}\n${JSON.stringify(body)}`)}` },
          },
          state.deadline + 20_000,
        );
        articleId = created.data.id;
        current = { id: created.data.id, slug: created.data.slug ?? null, status: "draft", published_at: null };
      } catch (err) {
        if (err instanceof WritavoApiError && err.code === "SLUG_CONFLICT") {
          const owner = article.slug ? await findBySlug(article.slug, state.deadline + 20_000).catch(() => null) : null;
          const reason = `slug "${article.slug}" is already used on the Site by article ${owner?.id ?? "(unknown)"}${owner?.external_id ? ` (external_id ${owner.external_id})` : owner ? ", which has no external_id" : ""}. Change the slug in the file, or change that article, then run again with retry_failed: true.`;
          record(state, item, { outcome: "skipped", error: reason });
          state.counts.skipped += 1;
          state.problems.push(`- ${label}: skipped, ${reason}`);
          return;
        }
        throw err;
      }
      action = "created";
      state.counts.created += 1;
    }
    // An article this import created stays "created" in the totals when a later run updates it.
    if (previous?.action === "created" && previous.article_id === articleId) action = "created";
    record(state, item, {
      outcome: needsPublish ? "retry" : "done",
      article_id: articleId,
      action,
      published: previous?.article_id === articleId ? (previous.published ?? false) : false,
      error: undefined,
      warnings,
    });
    save(state);
  }

  if (needsPublish && !(previous && previous.hash === item.hash && previous.published)) {
    current ??= await getArticleState(articleId!, state.deadline + 20_000);
    if (current.status !== "published") {
      const firstPublish = !current.published_at;
      if (!firstPublish && article.published_at && Date.parse(current.published_at!) !== Date.parse(article.published_at)) {
        warnings.push(`it keeps its existing publish date ${current.published_at} (the file says ${article.published_at})`);
      }
      await call(
        {
          method: "POST",
          path: `/articles/${encodeURIComponent(articleId!)}/publish`,
          // Original dates count on a first publish only; an article that was published before
          // keeps its date, and sending a different one would be refused.
          ...(firstPublish
            ? { body: { published_at: article.published_at, ...(article.content_updated_at ? { content_updated_at: article.content_updated_at } : {}) } }
            : {}),
        },
        state.deadline + 20_000,
      );
      state.counts.published += 1;
    }
    record(state, item, { outcome: "done", article_id: articleId, published: true, error: undefined, warnings });
  } else {
    record(state, item, { outcome: "done", article_id: articleId, error: undefined, warnings });
  }
  for (const w of warnings) state.warnings.push(`- ${label}: ${w}`);
  save(state);
}

async function apply(opts: ImportOptions, ctx: Loaded): Promise<ToolResult> {
  const mayTouchLive = opts.publish && opts.confirm;
  const pending = ctx.valid.filter((v) => !isSettled(ctx.progress.items[v.article.external_id], v, opts, mayTouchLive));
  const invalid = ctx.items.filter((i) => i.errors.length > 0);

  const toPublish = pending.filter((v) => v.article.status === "published").length;
  if (opts.publish && toPublish > 0 && !opts.confirm) {
    return text(
      [
        "Nothing has been done. This import needs the user to confirm first.",
        "",
        `It publishes ${plural(toPublish, "article")} on the Site "${ctx.site.name}" with their original dates, where search engines and readers will see them, and updates to articles already live take effect immediately.${pending.length > toPublish ? ` Drafts imported as drafts: ${pending.length - toPublish}.` : ""}`,
        "",
        "Ask the user whether to go ahead. If they agree, call:",
        nextCall(opts, { confirm: true }),
        "To import everything as drafts instead, with nothing made public, pass publish: false.",
      ].join("\n"),
    );
  }

  const state: ApplyState = {
    opts,
    ctx,
    deadline: Date.now() + TIME_BUDGET_MS,
    mayTouchLive,
    counts: { created: 0, updated: 0, published: 0, deferred: 0, skipped: 0, failed: 0, imagesCopied: 0, imagesFailed: 0 },
    problems: [],
    warnings: [],
  };

  let stopped: string | null = null;
  try {
    if (!(await ensureTaxonomy(state))) stopped = "the time for this call ran out while creating categories, tags and authors";
  } catch (err) {
    save(state);
    if (err instanceof ItemProblem) return toolError(`import_content stopped: ${err.message}. Nothing after it was imported. Progress is saved in ${ctx.progressFile}.`);
    if (isTransient(err)) stopped = `the API was busy (${apiProblem(err)})`;
    else return stopReport(state, err);
  }

  let processed = 0;
  if (!stopped) {
    for (const item of pending) {
      if (processed >= opts.batchSize) break;
      if (Date.now() > state.deadline) {
        stopped = "the time for this call ran out";
        break;
      }
      processed += 1;
      const label = itemLabel(item.check);
      try {
        await processArticle(state, item);
      } catch (err) {
        if (isFatal(err)) {
          save(state);
          return stopReport(state, err);
        }
        if (isTransient(err)) {
          const attempts = (ctx.progress.items[item.article.external_id]?.hash === item.hash ? (ctx.progress.items[item.article.external_id]?.attempts ?? 0) : 0) + 1;
          if (attempts >= 3) {
            record(state, item, { outcome: "failed", error: apiProblem(err), attempts });
            state.counts.failed += 1;
            state.problems.push(`- ${label}: failed three times in a row, last with ${apiProblem(err)}`);
          } else {
            record(state, item, { outcome: "retry", error: apiProblem(err), attempts });
            stopped = `the API was busy (${apiProblem(err)}); ${label} is tried again on the next call`;
            save(state);
            break;
          }
        } else {
          const reason = err instanceof ItemProblem ? err.message : apiProblem(err);
          record(state, item, { outcome: "failed", error: reason });
          state.counts.failed += 1;
          state.problems.push(`- ${label}: failed, ${reason}`);
        }
        save(state);
      }
    }
  }
  save(state);

  // Counted as the NEXT call will see it, which does not pass retry_failed again.
  const nextOpts = { ...opts, retryFailed: false };
  const remaining = ctx.valid.filter((v) => !isSettled(ctx.progress.items[v.article.external_id], v, nextOpts, mayTouchLive)).length;
  const c = state.counts;
  const lines: string[] = [];
  const thisCall = `This call: created ${c.created}, updated ${c.updated}, published ${c.published}, left unchanged ${c.deferred}, skipped ${c.skipped}, failed ${c.failed}. Images copied ${c.imagesCopied}${c.imagesFailed ? `, not copied ${c.imagesFailed}` : ""}.`;
  const created = ctx.progress.created;

  if (remaining === 0) {
    const entries = Object.entries(ctx.progress.items);
    const tally = (pred: (e: ProgressItem) => boolean) => entries.filter(([, e]) => pred(e)).length;
    lines.push(
      `Import complete for the Site "${ctx.site.name}". Every valid article in ${opts.filePath} has been processed.`,
      "",
      thisCall,
      `Across the whole import: created ${tally((e) => e.action === "created")}, updated ${tally((e) => e.action === "updated")}, published ${tally((e) => e.published === true)}, left unchanged ${tally((e) => e.outcome === "deferred")}, skipped ${tally((e) => e.outcome === "skipped")}, failed ${tally((e) => e.outcome === "failed")}${invalid.length ? `, not imported because of problems in the file ${invalid.length}` : ""}. Categories created ${created.categories}, tags ${created.tags}, authors ${created.authors}. Images copied ${Object.values(ctx.progress.images).filter((i) => i.url).length}.`,
    );
    const attention = entries
      .filter(([, e]) => e.outcome === "skipped" || e.outcome === "failed" || e.outcome === "deferred")
      .map(([id, e]) => `- ${id}: ${e.outcome}, ${e.error ?? "no reason recorded"}`);
    if (attention.length > 0) lines.push("", "Needs attention:", ...listed(attention));
    if (invalid.length > 0) {
      lines.push("", "Not imported because of problems in the file:", ...listed(invalid.map((i) => `- ${itemLabel(i)}: ${i.errors.join("; ")}`)));
    }
    if (state.warnings.length > 0) lines.push("", "Warnings from this call:", ...listed(state.warnings));
    lines.push(
      "",
      `Progress is saved in ${ctx.progressFile}. Running the same import again is safe: it changes nothing unless the file changed.`,
      "Next: verify with list_articles (for example status published, order published_at.desc, fields id,title,slug,published_at) that the counts, slugs and dates match the source.",
    );
  } else {
    lines.push(
      `Imported a batch into the Site "${ctx.site.name}". ${ctx.valid.length - remaining} of ${ctx.valid.length} articles are done and ${remaining} remain.`,
      "",
      thisCall,
      `Categories created so far ${created.categories}, tags ${created.tags}, authors ${created.authors}.`,
    );
    if (stopped) lines.push(`Stopped early: ${stopped}.`);
    if (state.problems.length > 0) lines.push("", "Problems this call:", ...listed(state.problems));
    if (state.warnings.length > 0) lines.push("", "Warnings this call:", ...listed(state.warnings));
    lines.push(
      "",
      `Progress is saved in ${ctx.progressFile}.`,
      "Next: call import_content again with the same arguments to continue:",
      nextCall(opts, { ...(opts.confirm ? { confirm: true } : {}) }),
    );
  }
  return text(lines.join("\n"));
}

/** A failure no other article can get past: the API's own guidance, then where the import stands. */
function stopReport(state: ApplyState, err: unknown): ToolResult {
  const guidance = formatApiError(err, { tool: "import_content" }).content.map((c) => c.text).join("\n");
  const c = state.counts;
  return toolError(
    [
      guidance,
      "",
      `Before it stopped, this call created ${c.created}, updated ${c.updated} and published ${c.published} articles. Progress is saved in ${state.ctx.progressFile}; fix the cause and call import_content again with the same arguments to carry on from there.`,
    ].join("\n"),
  );
}

/**
 * Imports running in this process, by file. A client that gave up waiting on a call can send the
 * next one while the first is still working; two batches racing over one progress file would
 * each record half of what happened. Nothing would be duplicated (every write is idempotent), but
 * the second call is refused anyway, because there is nothing useful for it to do yet.
 */
const running = new Set<string>();

export async function runImport(opts: ImportOptions): Promise<ToolResult> {
  if (opts.dryRun) {
    const loaded = await load(opts);
    return "content" in loaded ? loaded : dryRun(opts, loaded);
  }
  if (running.has(opts.filePath)) {
    return text(
      `An import of ${opts.filePath} from an earlier call is still running. Nothing new was started. Wait a few seconds and call import_content again with the same arguments.`,
    );
  }
  running.add(opts.filePath);
  try {
    const loaded = await load(opts);
    return "content" in loaded ? loaded : await apply(opts, loaded);
  } finally {
    running.delete(opts.filePath);
  }
}
