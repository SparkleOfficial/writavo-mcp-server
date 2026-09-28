import { createHash } from "node:crypto";
import { WritavoApiError } from "../api/client.js";
import { MediaError, fetchImage, uploadImage } from "../api/media.js";
import { newApiStats, type ApiStats, type ToolContext } from "../core/context.js";
import { formatApiError, text, toolError, type ToolResult } from "../errors.js";
import { howtoSteps, type CostEntry, type ImportArticle, type ImportAuthor, type ImportEnvelope, type ImportTerm } from "./format.js";
import { articleImages, htmlImageCount, isHttps, rewriteMarkdownImages } from "./images.js";
import { newProgress, type ImportProgress, type ProgressItem, type ProgressStore } from "./progress.js";
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
import { checkDocument, itemLabel, type EngagementCheck, type ItemCheck } from "./validate.js";

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
 *   - what is done is recorded in the host's progress store after every article, when the host
 *     has one (the stored import job, on the hosted server).
 *
 * Nothing is ever deleted or unpublished, and nothing in the customer's prose is rewritten except
 * the URLs of images that were copied into the media library.
 *
 * The engine never touches a filesystem. Where the document came from and where progress is kept
 * are the host's business, passed in as an ImportSource, because the engine runs in a Worker that
 * has neither a file to read nor anywhere to write one.
 */

/** The document being imported, and what the host can do for it. */
export interface ImportSource {
  /** How replies name the document: "the import imp_...", or "the inline document". */
  label: string;
  /** The parsed JSON, not yet validated. */
  document: unknown;
  /** Where progress persists between calls. Null for inline data, which is re-sent each call. */
  store: ProgressStore | null;
  /** The argument that names this document again in a follow-up call; null for inline data. */
  reference: Record<string, unknown> | null;
  /**
   * Serialises two applies of the same document across Worker isolates: the hosted import job,
   * which any isolate may be asked to continue. Null for inline data, which has nothing to share.
   */
  lease: ImportLease | null;
  /** batch_size when the call gives none. */
  defaultBatchSize: number;
  /** How long the host took to produce the document this call (a stored import's read), for the timing line. */
  openMs?: number;
}

/** A short exclusive hold on one import, released when the call ends and expiring by itself. */
export interface ImportLease {
  /** ok: this call now holds it. Otherwise another call does, until `until` (epoch ms) at the latest. */
  acquire(): Promise<{ ok: true } | { ok: false; until: number | null }>;
  release(): Promise<void>;
}

export interface ImportBudget {
  workMs: number;
  graceMs: number;
  /**
   * Outbound requests one call may make, when its host caps them (Cloudflare Workers: 50 per
   * invocation on the free plan, 1000 on paid). The engine stops starting new work before it would
   * pass the cap, so a call ends cleanly instead of failing on its 51st request. Unset: no cap.
   */
  maxRequests?: number;
}

/**
 * A tool call's time: new work starts only within workMs of the call starting, and everything in
 * flight is cut off graceMs after that. 18 + 7 keeps a whole call, document read included, under
 * the ~30 s an MCP client waits for a tool: a call that outlives its client is not lost (the work
 * is recorded), but the client reports a timeout and the next call finds the import still held.
 */
export const FOREGROUND_BUDGET: ImportBudget = { workMs: 18_000, graceMs: 7_000 };

export interface ImportOptions {
  /** When the tool call started (epoch ms): the budget counts from here, document reads included. */
  startedAt?: number;
  /** How long a call starts new work, and how long past that it may finish what is in flight. */
  budget?: ImportBudget;
  dryRun: boolean;
  confirm: boolean;
  batchSize: number;
  rehostImages: boolean;
  publish: boolean;
  retryFailed: boolean;
}

/** Per key, per minute (contract section 2b). Used for the dry run's estimate only. */
const RATE = { read: 600, write: 120, upload: 60 };
/** The dry run's estimate of one call's working time. */
const TIME_BUDGET_MS = FOREGROUND_BUDGET.workMs;
/**
 * Typical wall time per request once functions run beside the database (2026-09-28), for the dry
 * run's estimate only. An image is its source fetch, two upload calls and the storage PUT.
 */
const LATENCY_MS = { read: 400, write: 700, image: 2_000 };
/**
 * Articles whose dates carry more than millisecond precision (…:34.967476Z). Writavo stores dates
 * to the millisecond, so the extra digits are dropped: harmless, but an exact-string comparison
 * against the source would look like a mismatch, so the reports say so.
 */
function subMillisecondNote(valid: ValidItem[]): string | null {
  const precise = /\.\d{4,}/;
  const hits = valid.filter(({ article }) => precise.test(article.published_at ?? "") || precise.test(article.content_updated_at ?? ""));
  if (hits.length === 0) return null;
  return `${plural(hits.length, "article")} ${hits.length === 1 ? "has" : "have"} dates with more than millisecond precision (for example ${hits[0]!.article.published_at ?? hits[0]!.article.content_updated_at}). Writavo stores dates to the millisecond, so the extra digits are dropped; compare dates to the millisecond when checking against the source.`;
}

/** What the importer writes for an article; bumping it makes finished articles pending again (load). */
const WRITE_VERSION = "v2";
/** At most one mid-call progress write this often; every way a call ends writes regardless (save). */
const SAVE_EVERY_MS = 3_000;
/** Categories and tags created side by side, well inside the API's 120 writes a minute per key. */
const TERM_CONCURRENCY = 4;
/** An article's images copied side by side. Uploads are 60 a minute per key; three keep it busy. */
const IMAGE_CONCURRENCY = 3;
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

/** The call's request budget is spent. Not a failure: the item stays pending for the next call. */
class OutOfRequests extends Error {}

/** API requests, image fetches and storage uploads this call has made. */
function requestsUsed(state: ApplyState): number {
  const s = state.ctx.api.stats;
  return state.extraRequests + (s ? s.reads.count + s.writes.count + s.uploads.count : 0);
}

/** Room for `n` more requests in this call's budget, or OutOfRequests. */
function need(state: ApplyState, n: number): void {
  const max = state.opts.budget?.maxRequests;
  if (max !== undefined && requestsUsed(state) + n > max) throw new OutOfRequests();
}

const REQUEST_BUDGET_SPENT = "this call's request budget ran out";

interface ValidItem {
  check: ItemCheck;
  article: ImportArticle;
  hash: string;
}

interface Loaded {
  api: ToolContext;
  source: ImportSource;
  envelope: ImportEnvelope;
  /** Problems in the document's top level. The dry run lists them; an apply refuses while any remain. */
  envelopeErrors: string[];
  /** The engagement section's valid rows and skipped-row problems (validate.ts). */
  engagement: EngagementCheck;
  /** Where this call's time went, for the reply (timingLine). */
  timing: CallTiming;
  items: ItemCheck[];
  valid: ValidItem[];
  site: SiteInfo;
  progress: ImportProgress;
  progressExisted: boolean;
  siteCategories: Map<string, string>;
  siteTags: Map<string, string>;
  siteAuthors: SiteAuthors;
  formats: Map<string, string>;
}

/** The Site's authors, by slug and by exact name (first one wins for a shared name). */
interface SiteAuthors {
  bySlug: Map<string, SiteAuthor>;
  byName: Map<string, SiteAuthor>;
}

const AUTHOR_FIELDS = "id,name,slug,bio,avatar_url,job_title,socials,author_type";

function addSiteAuthor(site: SiteAuthors, a: SiteAuthor): void {
  if (a.slug && !site.bySlug.has(a.slug)) site.bySlug.set(a.slug, a);
  if (!site.byName.has(a.name)) site.byName.set(a.name, a);
}

/** The author already on the Site for a file author: by slug when the file gives one, else by name. */
function matchAuthor(site: SiteAuthors, author: ImportAuthor): SiteAuthor | undefined {
  return (author.slug ? site.bySlug.get(author.slug) : undefined) ?? site.byName.get(author.name);
}

/**
 * What an import may add to an author that is already on the Site: only the fields that are empty
 * there. A person may have edited the profile since, so nothing they wrote is overwritten, and the
 * slug and name are never touched (either would move or rename a live byline). author_type counts
 * as empty while it is the default, user. socials gain the networks the Site has no link for.
 * The avatar is left to the caller, because it has to be copied into the media library first.
 */
function authorGaps(site: SiteAuthor, file: ImportAuthor): Record<string, unknown> {
  const gaps: Record<string, unknown> = {};
  if (!site.bio && file.bio) gaps.bio = file.bio;
  if (!site.job_title && file.job_title) gaps.job_title = file.job_title;
  if ((site.author_type ?? "user") === "user" && file.author_type && file.author_type !== "user") gaps.author_type = file.author_type;
  const have = site.socials ?? {};
  const added = Object.entries(file.socials ?? {}).filter(([network, url]) => url && !have[network]);
  if (added.length) gaps.socials = { ...have, ...Object.fromEntries(added) };
  return gaps;
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
/** Where progress is, or why there is none, for the closing line of a reply. */
function progressNote(ctx: Loaded): string {
  return ctx.source.store
    ? `Progress is saved in ${ctx.source.store.location}.`
    : "Nothing is saved between calls for an inline document; articles are matched by external_id, so sending one again updates it rather than duplicating it.";
}

/** Wall-clock milliseconds by phase, for the line every apply reply ends with. */
interface CallTiming {
  open: number;
  validate: number;
  site: number;
  terms: number;
  articles: number;
  saves: { count: number; ms: number };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Where one call's time went: the document, the checks, the Site reads, and then the writes by
 * kind with their average, so a slow import says whether the API, the rate limits or the import
 * itself is the bottleneck.
 */
function timingLine(timing: CallTiming, stats: ApiStats | undefined): string {
  const parts = [
    ...(timing.open ? [`document ${seconds(timing.open)}`] : []),
    `checks ${seconds(timing.validate)}`,
    `Site reads ${seconds(timing.site)}`,
    ...(timing.terms ? [`categories, tags and authors ${seconds(timing.terms)}`] : []),
    ...(timing.articles ? [`articles and images ${seconds(timing.articles)}`] : []),
    ...(timing.saves.count ? [`saving progress ${seconds(timing.saves.ms)} (${timing.saves.count}x)`] : []),
  ];
  const api = stats
    ? (["writes", "uploads", "reads"] as const)
        .filter((k) => stats[k].count > 0)
        .map((k) => `${stats[k].count} ${k} ${seconds(stats[k].ms)} (${(stats[k].ms / stats[k].count / 1000).toFixed(2)} s each)`)
    : [];
  const waits = stats && stats.waitMs ? [`waiting out rate limits ${seconds(stats.waitMs)}${stats.rateLimited ? ` (${stats.rateLimited} refusals)` : ""}`] : [];
  return `Where this call's time went: ${parts.join(", ")}.${api.length ? ` API: ${[...api, ...waits].join(", ")}.` : ""}`;
}

async function load(api: ToolContext, source: ImportSource): Promise<Loaded | ToolResult> {
  const timing: CallTiming = { open: source.openMs ?? 0, validate: 0, site: 0, terms: 0, articles: 0, saves: { count: 0, ms: 0 } };
  let mark = Date.now();
  const checked = checkDocument(source.document);
  timing.validate = Date.now() - mark;
  mark = Date.now();
  if (!checked.envelope) {
    return toolError(
      [
        `${source.label} is not a valid Writavo import document, so nothing was checked against the Site and nothing was written.`,
        "",
        ...listed(checked.envelopeErrors.map((e) => `- ${e}`)),
        "",
        "Read the resource writavo://import-format, or call import_content with no document, for the format.",
      ].join("\n"),
    );
  }
  // Problems in the document's top level (an author, category or tag entry, a duplicate slug)
  // no longer stop the checks: the entries that parse are kept, every article is still checked,
  // and the dry run reports everything in one pass. An apply refuses while any remain (apply()).
  const envelope = checked.envelope;

  let site: SiteInfo;
  let siteCategories: Map<string, string>;
  let siteTags: Map<string, string>;
  let siteAuthors: SiteAuthors;
  let formats: Map<string, string>;
  try {
    site = await getSite(api);
    const [categories, tags, authors, types] = await Promise.all([
      listAll<SiteTerm>(api, "/categories", [["fields", "id,name,slug"]]),
      listAll<SiteTerm>(api, "/tags", [["fields", "id,name,slug"]]),
      listAll<SiteAuthor>(api, "/authors", [["fields", AUTHOR_FIELDS]]),
      call<{ items: SiteContentType[] }>(api, { method: "GET", path: "/content-types" }),
    ]);
    siteCategories = new Map(categories.map((c) => [c.slug, c.id]));
    siteTags = new Map(tags.map((t) => [t.slug, t.id]));
    siteAuthors = { bySlug: new Map(), byName: new Map() };
    for (const a of authors) addSiteAuthor(siteAuthors, a);
    formats = new Map();
    for (const t of types.data?.items ?? []) if (t.is_active !== false || !formats.has(t.key)) formats.set(t.key, t.id);
  } catch (err) {
    return formatApiError(err, { tool: "import_content" });
  }

  const store = source.store;
  const existing = store ? await store.read() : null;
  timing.site = Date.now() - mark;
  if (store && typeof existing === "string") {
    return toolError(
      `The saved progress in ${store.location} cannot be used because ${existing}. ${store.resetHint}; articles already imported are found again by external_id, so nothing is duplicated.`,
    );
  }
  if (store && existing && typeof existing !== "string" && existing.website_id !== site.id) {
    return toolError(
      `The saved progress in ${store.location} belongs to an import into a different Site ("${existing.website_name}"). This connection is for "${site.name}". If importing into "${site.name}" is intended: ${store.resetHint}. Otherwise connect to the right Site.`,
    );
  }
  const saved = typeof existing === "string" ? null : existing;
  const progress = saved ?? newProgress(source.label, site);

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
    // The hash says "this article is done as the file has it". It carries the version of what the
    // importer WRITES, so an article done by an older importer is written again (in place, by
    // external_id; images already copied are not copied again): v2 (2026-09-28) records the
    // source's original dates on drafts, which v1 did not send.
    if (item.errors.length === 0) valid.push({ check: item, article, hash: sha256(`${WRITE_VERSION}:${JSON.stringify(article)}`) });
  }

  return {
    api,
    source,
    envelope,
    envelopeErrors: checked.envelopeErrors,
    engagement: checked.engagement,
    timing,
    items: checked.items,
    valid,
    site,
    progress,
    progressExisted: saved !== null,
    siteCategories,
    siteTags,
    siteAuthors,
    formats,
  };
}

/** The follow-up call, spelled out. An inline document cannot be quoted back, so it is referred to. */
function nextCall(source: ImportSource, opts: ImportOptions, overrides: Record<string, unknown>): string {
  const args: Record<string, unknown> = { ...(source.reference ?? {}), dry_run: false };
  if (!opts.publish) args.publish = false;
  if (!opts.rehostImages) args.rehost_images = false;
  if (source.reference && opts.batchSize !== source.defaultBatchSize) args.batch_size = opts.batchSize;
  Object.assign(args, overrides);
  return source.reference
    ? `import_content ${JSON.stringify(args)}`
    : `import_content with the same data and ${JSON.stringify(args)}`;
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------
async function dryRun(opts: ImportOptions, ctx: Loaded): Promise<ToolResult> {
  const { envelope, valid, progress, site } = ctx;

  let index: SiteArticle[];
  try {
    index = await listAll<SiteArticle>(ctx.api, "/articles", [["fields", ARTICLE_STATE_FIELDS]]);
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
  const authorsToCreate = (envelope.authors ?? []).filter((a) => !matchAuthor(ctx.siteAuthors, a));
  for (const a of authorsToCreate) if (a.avatar_url) consider(a.avatar_url);
  const authorsToFill = (envelope.authors ?? []).filter((a) => {
    const known = matchAuthor(ctx.siteAuthors, a);
    return known && (Object.keys(authorGaps(known, a)).length > 0 || (!known.avatar_url && a.avatar_url));
  });
  for (const a of authorsToFill) if (a.avatar_url && !matchAuthor(ctx.siteAuthors, a)?.avatar_url) consider(a.avatar_url);
  const categoriesToCreate = (envelope.categories ?? []).filter((c) => !ctx.siteCategories.has(c.slug));
  const tagsToCreate = (envelope.tags ?? []).filter((t) => !ctx.siteTags.has(t.slug));

  let documents = "";
  try {
    const usage = await call<{ limits?: { key: string; limit: number | null; used: number }[] }>(ctx.api, { method: "GET", path: "/usage" });
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
  const writes = categoriesToCreate.length + tagsToCreate.length + authorsToCreate.length + authorsToFill.length + pending.length + counts.publish;
  const uploads = (opts.rehostImages ? toCopy.size : 0) * 2;
  const termWrites = categoriesToCreate.length + tagsToCreate.length;
  // The slower of two limits: the API's per-minute budgets, and the time each request takes when
  // they are made one after another (terms go TERM_CONCURRENCY at a time). One call works for
  // TIME_BUDGET_MS, so the number of calls follows from the time, not from the batch size.
  const byRate = Math.max(reads / RATE.read, writes / RATE.write, uploads / RATE.upload) * 60_000;
  const imageCopies = opts.rehostImages ? toCopy.size : 0;
  const bySpeed =
    reads * LATENCY_MS.read + (writes - termWrites) * LATENCY_MS.write + (termWrites * LATENCY_MS.write) / TERM_CONCURRENCY + imageCopies * LATENCY_MS.image;
  const totalMs = Math.max(byRate, bySpeed);
  const minutes = Math.max(1, Math.ceil(totalMs / 60_000));
  const calls = Math.max(1, Math.ceil(totalMs / TIME_BUDGET_MS), Math.ceil(pending.length / opts.batchSize));

  const invalid = ctx.items.filter((i) => i.errors.length > 0);
  counts.blocked = invalid.length;
  const published = valid.filter((v) => v.article.status === "published").length;

  const lines = [
    `Dry run of ${ctx.source.label} for the Site "${site.name}". Nothing was written.`,
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
    `Categories: ${(envelope.categories ?? []).length} in the file, ${categoriesToCreate.length} to create. Tags: ${(envelope.tags ?? []).length} in the file, ${tagsToCreate.length} to create. Authors: ${(envelope.authors ?? []).length} in the file, ${authorsToCreate.length} to create, ${authorsToFill.length} already on the Site to fill in (matched by slug, else exact name; only empty fields are filled).`,
    opts.rehostImages
      ? `Images to copy into the media library: ${toCopy.size}.${notHttps.size ? ` Not https, so kept at their original URLs: ${notHttps.size}.` : ""}`
      : `Images: not copied (rehost_images is false); ${toCopy.size + notHttps.size} keep their original URLs.`,
    ...(htmlImages
      ? [`${htmlImages} images are HTML <img> tags inside content. Only markdown images are copied, so those keep their original URLs; convert them to ![alt](url) in the file to have them copied.`]
      : []),
    documents,
    `Estimate: about ${reads} reads, ${writes} writes and ${uploads} upload calls. At the API's rate limits (${RATE.read} reads, ${RATE.write} writes, ${RATE.upload} uploads per minute) and typical request times, that is about ${minutes} minute${minutes === 1 ? "" : "s"}${byRate >= bySpeed ? ", set by the rate limits" : ""}, over about ${calls} call${calls === 1 ? "" : "s"} of import_content (each works for about ${TIME_BUDGET_MS / 1000} seconds). Every apply reply ends with where its time went, so the real pace is visible after the first call.`,
  ];
  if (ctx.progressExisted && ctx.source.store) lines.push(`Progress from an earlier run is in ${ctx.source.store.location}.`);
  const precision = subMillisecondNote(valid);
  if (precision) lines.push(precision);
  lines.push(...engagementDryRun(ctx, byExternalId, bySlug));

  const topLevel = ctx.envelopeErrors;
  if (topLevel.length > 0) {
    lines.push(
      "",
      `Problems in the document's top level (${topLevel.length}). Nothing can be imported until these are fixed; entries with a problem were left out of the checks above:`,
      ...listed(topLevel.map((e) => `- ${e}`)),
    );
  }
  if (invalid.length > 0) {
    lines.push("", `Problems (${invalid.length} articles). These are not imported until fixed:`);
    lines.push(...listed(invalid.map((i) => `- ${itemLabel(i)}: ${i.errors.join("; ")}`)));
  }
  if (warnings.length > 0) lines.push("", `Warnings (${warnings.length}). These do not stop the import:`, ...listed(warnings));

  lines.push("");
  if (topLevel.length > 0) {
    lines.push(
      "Every problem found is listed above, top level and articles together. Fix them all in the document, then run the dry run again.",
      ...(ctx.source.reference
        ? [`This import is stored as ${JSON.stringify(ctx.source.reference)}: send the corrected entries as data with that import_id (an entry with the same ref, slug or external_id replaces the stored one), or start a new import with the corrected document.`]
        : []),
    );
    return text(lines.join("\n"));
  }
  if (pending.length === 0) {
    lines.push(invalid.length > 0 ? "Nothing else to import. Fix the problems above and run the dry run again." : "Nothing to import: everything in the document is already on the Site.");
  } else {
    const needsConfirm = opts.publish && pending.some((p) => p.article.status === "published");
    if (invalid.length > 0) {
      lines.push("Fix the problems above in the document and run the dry run again. Or apply now: the articles with problems are skipped and reported, and everything else is imported.");
    }
    lines.push(
      needsConfirm
        ? `To apply, first ask the user: this publishes ${plural(counts.publish, "article")} on their live site with their original dates${counts.update ? `, and updates to articles already live take effect immediately` : ""}. If they agree, call:`
        : "To apply, call:",
      nextCall(ctx.source, opts, needsConfirm ? { confirm: true } : {}),
      ctx.source.store
        ? "Then call it again with the same arguments until it reports the import is complete."
        : "If a call stops before the end, it lists the articles still to do; send only those in the next call.",
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
  /** No new work starts after this. */
  deadline: number;
  /** Everything still in flight is cut off at this (the API client's own deadline). */
  hardDeadline: number;
  mayTouchLive: boolean;
  counts: { created: number; updated: number; published: number; deferred: number; skipped: number; failed: number; imagesCopied: number; imagesFailed: number };
  problems: string[];
  warnings: string[];
  /** When progress was last written (save). */
  lastSave: number;
  /** The progress write in flight, so writes land in order. */
  saving: Promise<void>;
  /** Requests the API client does not tally: image fetches and storage uploads. */
  extraRequests: number;
}

/**
 * Record progress. Mid-call saves are throttled to one every SAVE_EVERY_MS: a stored import's
 * progress is a network write, and paying it after every term, image and article was a real part
 * of a slow call. `force` (every way a call ends) always writes. What a call that dies between two
 * saves loses is at most SAVE_EVERY_MS of work, all of it idempotent to redo (Idempotency-Key and
 * external_id matching), except an image copied twice.
 */
async function save(state: ApplyState, force = false): Promise<void> {
  const store = state.ctx.source.store;
  if (!store) return;
  const now = Date.now();
  if (!force && now - state.lastSave < SAVE_EVERY_MS) return;
  // Claimed before the await, and chained: terms are created side by side, and two writes in
  // flight at once could land in the wrong order, an older snapshot over a newer one.
  state.lastSave = now;
  const write = state.saving.then(async () => {
    const started = Date.now();
    state.ctx.progress.updated_at = new Date(started).toISOString();
    await store.write(state.ctx.progress);
    state.ctx.timing.saves.count += 1;
    state.ctx.timing.saves.ms += Date.now() - started;
  });
  state.saving = write.catch(() => undefined);
  await write;
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
  need(state, 4); // the fetch, the reservation, the storage upload, the registration
  try {
    state.extraRequests += 2;
    // Bounded by the call's budget, so one slow image host cannot hold a call open for minutes.
    const fetched = await fetchImage(url, undefined, Math.max(3_000, Math.min(30_000, state.hardDeadline - Date.now())));
    if (!fetched.contentType) throw new MediaError("it is not one of the accepted image types");
    const asset = await retrying(state, () =>
      uploadImage(state.ctx.api, { bytes: fetched.bytes, fileName: fetched.fileName, contentType: fetched.contentType!, altText: alt || undefined, bucket }),
    );
    const hosted = typeof asset.url === "string" ? asset.url : "";
    if (!hosted) throw new MediaError("the media library returned no URL");
    progress.images[url] = { url: hosted };
    state.counts.imagesCopied += 1;
    return hosted;
  } catch (err) {
    if (isTransient(err) || isFatal(err) || err instanceof OutOfRequests) throw err;
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
      if (Date.now() + wait > state.hardDeadline) throw err;
      if (state.ctx.api.stats) state.ctx.api.stats.waitMs += wait;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/**
 * Run `task` over `items` with at most `limit` in flight. The first error stops new tasks from
 * starting and is thrown once the ones already running have settled, so nothing is left writing
 * behind a reply.
 */
async function inPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (failure === null && next < items.length) {
      const item = items[next++]!;
      try {
        await task(item);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== null) throw failure;
}

/** A term's optional descriptive fields, only those the file actually sets. group_label is a tag's
 *  alone: the categories schema has no such field, so it never appears on one. */
function termExtras(term: ImportTerm): { description?: string; group_label?: string } {
  const out: { description?: string; group_label?: string } = {};
  if (term.description?.trim()) out.description = term.description.trim();
  if (term.group_label?.trim()) out.group_label = term.group_label.trim();
  return out;
}

async function ensureTaxonomy(state: ApplyState): Promise<boolean> {
  const { ctx, opts } = state;
  const { progress, envelope } = ctx;

  const terms: { kind: "categories" | "tags"; site: Map<string, string>; list: ImportTerm[] }[] = [
    { kind: "categories", site: ctx.siteCategories, list: envelope.categories ?? [] },
    { kind: "tags", site: ctx.siteTags, list: envelope.tags ?? [] },
  ];
  for (const { kind, site, list } of terms) {
    // The descriptive fields of terms already on the Site, read once and only when the file has
    // something to fill: an existing term keeps what it has, and only empty fields are filled.
    let existing: Map<string, SiteTerm> | null = null;
    const missing: ImportTerm[] = [];
    for (const term of list) {
      const known = site.get(term.slug);
      const extras = termExtras(term);
      if (known) {
        if (Object.keys(extras).length) {
          if (Date.now() > state.deadline) return false;
          existing ??= new Map(
            (await listAll<SiteTerm>(ctx.api, `/${kind}`, [["fields", kind === "tags" ? "id,slug,description,group_label" : "id,slug,description"]]))
              .map((t) => [t.slug, t]),
          );
          const have = existing.get(term.slug);
          const fill = Object.fromEntries(Object.entries(extras).filter(([k]) => !have?.[k as keyof typeof extras]));
          if (Object.keys(fill).length) {
            await call(ctx.api, { method: "PATCH", path: `/${kind}/${known}`, body: fill }, state.hardDeadline);
          }
        }
        progress[kind][term.slug] = known;
        continue;
      }
      missing.push(term);
    }

    // Missing terms are created a few at a time: each is one write, independent of the others.
    let ranOut = false;
    await inPool(missing, TERM_CONCURRENCY, async (term) => {
      const max = state.opts.budget?.maxRequests;
      if (ranOut || Date.now() > state.deadline || (max !== undefined && requestsUsed(state) + TERM_CONCURRENCY > max)) {
        ranOut = true;
        return;
      }
      const body = { name: term.name, slug: term.slug, ...termExtras(term), ...(term.is_active === false ? { is_active: false } : {}) };
      let id: string | undefined;
      try {
        const created = await call<{ id: string }>(
          ctx.api,
          { method: "POST", path: `/${kind}`, body, headers: { "Idempotency-Key": `import-${kind}-${sha256(JSON.stringify(body))}` } },
          state.hardDeadline,
        );
        id = created.data?.id;
        progress.created[kind] += 1;
      } catch (err) {
        if (!(err instanceof WritavoApiError && err.code === "SLUG_CONFLICT")) throw err;
        // Created meanwhile, by someone else or by an earlier call that did not get to record it.
        const all = await listAll<SiteTerm>(ctx.api, `/${kind}`, [["fields", "id,name,slug"]]);
        id = all.find((t) => t.slug === term.slug)?.id;
      }
      if (!id) throw new ItemProblem(`the ${kind === "categories" ? "category" : "tag"} "${term.slug}" could not be created`);
      site.set(term.slug, id);
      progress[kind][term.slug] = id;
      await save(state);
    });
    if (ranOut) return false;
  }

  for (const author of envelope.authors ?? []) {
    const known = matchAuthor(ctx.siteAuthors, author);
    const gaps = known ? authorGaps(known, author) : {};
    const wantsAvatar = Boolean(author.avatar_url) && !(known && known.avatar_url);
    if (known && Object.keys(gaps).length === 0 && !wantsAvatar) {
      progress.authors[author.ref] = known.id;
      continue;
    }
    if (Date.now() > state.deadline) return false;
    const maxRequests = state.opts.budget?.maxRequests;
    if (maxRequests !== undefined && requestsUsed(state) + 6 > maxRequests) return false;
    const warnings: string[] = [];
    let avatar = wantsAvatar ? author.avatar_url ?? null : null;
    if (avatar && opts.rehostImages) avatar = (await rehost(state, avatar, author.name, "author-avatars", warnings)) ?? avatar;
    for (const w of warnings) state.warnings.push(`- author ${author.ref}: ${w}`);

    if (known) {
      const body = { ...gaps, ...(avatar ? { avatar_url: avatar } : {}) };
      const updated = await call<SiteAuthor>(
        ctx.api,
        { method: "PATCH", path: `/authors/${known.id}`, body, headers: { "Idempotency-Key": `import-author-fill-${sha256(known.id + JSON.stringify(body))}` } },
        state.hardDeadline,
      );
      Object.assign(known, updated.data ?? body);
      progress.authors[author.ref] = known.id;
      progress.filled_authors += 1;
      await save(state);
      continue;
    }

    const body = {
      name: author.name,
      ...(author.slug ? { slug: author.slug } : {}),
      ...(author.bio !== undefined ? { bio: author.bio } : {}),
      ...(avatar ? { avatar_url: avatar } : {}),
      ...(author.job_title ? { job_title: author.job_title } : {}),
      ...(author.socials && Object.keys(author.socials).length ? { socials: author.socials } : {}),
      ...(author.author_type ? { author_type: author.author_type } : {}),
      is_ai_generated: author.is_ai_generated ?? false,
      is_default: false,
    };
    let created: SiteAuthor | undefined;
    try {
      created = (
        await call<SiteAuthor>(
          ctx.api,
          { method: "POST", path: "/authors", body, headers: { "Idempotency-Key": `import-author-${sha256(JSON.stringify(body))}` } },
          state.hardDeadline,
        )
      ).data ?? undefined;
      if (created?.id) progress.created.authors += 1;
    } catch (err) {
      if (!(err instanceof WritavoApiError && err.code === "SLUG_CONFLICT")) throw err;
      // The slug belongs to an author with a different name. Take that one rather than invent a
      // second URL for the same person; a mismatch is reported so the person can check it.
      const all = await listAll<SiteAuthor>(ctx.api, "/authors", [["fields", AUTHOR_FIELDS]]);
      created = all.find((a) => a.slug === author.slug);
      if (created) state.warnings.push(`- author ${author.ref}: the slug "${author.slug}" is already the Site's author "${created.name}", so the import uses that author`);
    }
    if (!created?.id) throw new ItemProblem(`the author "${author.name}" could not be created`);
    addSiteAuthor(ctx.siteAuthors, { ...body, ...created });
    progress.authors[author.ref] = created.id;
    await save(state);
  }
  return true;
}

function buildBody(article: ImportArticle, ctx: Loaded, imageUrl: (url: string) => string | undefined): Record<string, unknown> {
  const { progress, envelope } = ctx;
  const body: Record<string, unknown> = { external_id: article.external_id };
  // The source's own dates, recorded on the article (0123) whether or not this run publishes it:
  // a draft imported now keeps them, and its first publish from ANY path (the dashboard, the API,
  // a schedule) uses them instead of today. Only for posts live at the source, whose dates are
  // checked to be in the past; an updated date before the published one is dropped (the API
  // refuses that pair). No effect on an article that is already published.
  if (article.status === "published" && article.published_at) {
    body.original_published_at = article.published_at;
    if (article.content_updated_at && Date.parse(article.content_updated_at) >= Date.parse(article.published_at)) {
      body.original_content_updated_at = article.content_updated_at;
    }
  }
  if (article.title !== undefined) body.title = article.title;
  if (article.slug !== undefined) body.slug = article.slug;
  if (article.content !== undefined) {
    body.content = article.content === null ? null : rewriteMarkdownImages(article.content, imageUrl);
  }
  if (article.excerpt !== undefined) body.excerpt = article.excerpt;
  if (article.featured_image !== undefined) {
    body.featured_image_url = article.featured_image === null ? null : (imageUrl(article.featured_image.url) ?? article.featured_image.url);
    // The article's own alt (0122), which the blog renders on the hero. The copy on the media
    // asset (rehost) is the library's; nothing on the page reads that one.
    body.featured_image_alt = article.featured_image === null ? null : (article.featured_image.alt ?? null);
  }
  if (article.seo_title !== undefined) body.seo_title = article.seo_title;
  if (article.seo_description !== undefined) body.seo_description = article.seo_description;
  if (article.seo_keywords !== undefined) body.seo_keywords = article.seo_keywords;
  if (article.faqs !== undefined) body.faqs = article.faqs;
  if (article.key_takeaways !== undefined) body.key_takeaways = article.key_takeaways;
  if (article.howto_steps !== undefined) {
    // Sent in the shape Writavo stores ({ name, description, steps }), whichever form the file used.
    const h = article.howto_steps;
    body.howto_steps =
      h === null
        ? null
        : {
            name: Array.isArray(h) ? "" : (h.name ?? ""),
            description: Array.isArray(h) ? "" : (h.description ?? ""),
            steps: howtoSteps(h).map((step) => (step.image_url ? { ...step, image_url: imageUrl(step.image_url) ?? step.image_url } : step)),
          };
  }
  if (article.comparison !== undefined) body.comparison = article.comparison;
  if (article.source !== undefined) body.source = article.source;

  if (article.category !== undefined) {
    const id = progress.categories[article.category] ?? ctx.siteCategories.get(article.category);
    if (!id) throw new ItemProblem(`category "${article.category}" is not on the Site`);
    body.category_id = id;
  }
  if (article.author !== undefined) {
    const name = (envelope.authors ?? []).find((a) => a.ref === article.author)?.name;
    const id = progress.authors[article.author] ?? (name ? ctx.siteAuthors.byName.get(name)?.id : undefined);
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
      await inPool(articleImages(article), IMAGE_CONCURRENCY, async (image) => {
        await rehost(state, image.url, image.alt, "blog-images", warnings);
      });
      await save(state);
    }
    const body = buildBody(article, ctx, (url) => (opts.rehostImages ? ctx.progress.images[url]?.url : undefined));

    // find, write, read back (+ publish, re-read) (+ the cost history), reserved before the write so
    // the article is never recorded done with its cost history still unsent
    need(state, (needsPublish ? 5 : 3) + (article.cost_history !== undefined ? 1 : 0));
    current = await findByExternalId(ctx.api, article.external_id, state.hardDeadline);
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
      await call(ctx.api, { method: "PATCH", path: `/articles/${encodeURIComponent(current.id)}`, body }, state.hardDeadline);
      articleId = current.id;
      action = "updated";
      state.counts.updated += 1;
    } else {
      try {
        const created = await call<SiteArticle>(
          ctx.api,
          {
            method: "POST",
            path: "/articles",
            body,
            // Derived, not random: the same article with the same body always sends the same key,
            // so a create that timed out and is sent again is replayed by the API, not repeated.
            headers: { "Idempotency-Key": `import-${sha256(`${article.external_id}\n${JSON.stringify(body)}`)}` },
          },
          state.hardDeadline,
        );
        articleId = created.data.id;
        current = { id: created.data.id, slug: created.data.slug ?? null, status: "draft", published_at: null };
      } catch (err) {
        if (err instanceof WritavoApiError && err.code === "SLUG_CONFLICT") {
          const owner = article.slug ? await findBySlug(ctx.api, article.slug, state.hardDeadline).catch(() => null) : null;
          const reason = `slug "${article.slug}" is already used on the Site by article ${owner?.id ?? "(unknown)"}${owner?.external_id ? ` (external_id ${owner.external_id})` : owner ? ", which has no external_id" : ""}. Change the slug in the document, or change that article, then run again${ctx.source.store ? " with retry_failed: true" : ""}.`;
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
    if (article.cost_history !== undefined) await sendCostHistory(state, articleId!, article.cost_history, warnings);
    await save(state);
  }

  if (needsPublish && !(previous && previous.hash === item.hash && previous.published)) {
    current ??= await getArticleState(ctx.api, articleId!, state.hardDeadline);
    if (current.status !== "published") {
      const firstPublish = !current.published_at;
      if (!firstPublish && article.published_at && Date.parse(current.published_at!) !== Date.parse(article.published_at)) {
        warnings.push(`it keeps its existing publish date ${current.published_at} (the file says ${article.published_at})`);
      }
      await call(
        ctx.api,
        {
          method: "POST",
          path: `/articles/${encodeURIComponent(articleId!)}/publish`,
          // Original dates count on a first publish only; an article that was published before
          // keeps its date, and sending a different one would be refused.
          ...(firstPublish
            ? { body: { published_at: article.published_at, ...(article.content_updated_at ? { content_updated_at: article.content_updated_at } : {}) } }
            : {}),
        },
        state.hardDeadline,
      );
      state.counts.published += 1;
    }
    record(state, item, { outcome: "done", article_id: articleId, published: true, error: undefined, warnings });
  } else {
    record(state, item, { outcome: "done", article_id: articleId, error: undefined, warnings });
  }
  for (const w of warnings) state.warnings.push(`- ${label}: ${w}`);
  // Always, not throttled: a finished article (and the images it copied) must be on record before
  // the next starts. A call killed after this (a client timeout, a runtime limit) loses nothing, so
  // the next call neither re-copies its images nor reports the Site ahead of its own progress.
  await save(state, true);
}

// ---------------------------------------------------------------------------
// Engagement history (the document's optional engagement section)
// ---------------------------------------------------------------------------
/** Rows per call to POST /engagement/import (the API's caps). */
const ENGAGEMENT_CHUNK = { daily: 5_000, reactions: 10_000 };

function engagementHash(e: EngagementCheck): string {
  return sha256(JSON.stringify({ d: e.daily, r: e.reactions }));
}

/** The section has rows that have not all been delivered, as the document now has them. */
function engagementPending(ctx: Loaded): boolean {
  const e = ctx.engagement;
  if (e.daily.length === 0 && e.reactions.length === 0) return false;
  const p = ctx.progress.engagement;
  return !(p && p.hash === engagementHash(e) && p.done);
}

/**
 * Send what is left of the section, a chunk per request. Each chunk SETS the totals for its post
 * days (and replaces its visitors' picks), so a chunk sent twice changes nothing. A reason to stop
 * (time, requests, a busy API), or null when this call finished (delivered, or refused for a reason
 * recorded in progress.engagement.error, which the next apply retries).
 */
async function sendEngagement(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const e = ctx.engagement;
  const hash = engagementHash(e);
  if (!ctx.progress.engagement || ctx.progress.engagement.hash !== hash) {
    ctx.progress.engagement = { hash, daily_sent: 0, reactions_sent: 0, done: false, written: { daily: 0, share_rows: 0, picks: 0 }, problems: [] };
  }
  const p = ctx.progress.engagement;
  delete p.error;
  for (const section of ["daily", "reactions"] as const) {
    const rows = e[section];
    const sentKey = section === "daily" ? "daily_sent" : "reactions_sent";
    while (p[sentKey] < rows.length) {
      if (Date.now() > state.deadline) return "the time for this call ran out while sending the engagement history";
      const max = state.opts.budget?.maxRequests;
      if (max !== undefined && requestsUsed(state) + 1 > max) return REQUEST_BUDGET_SPENT;
      const chunk = rows.slice(p[sentKey], p[sentKey] + ENGAGEMENT_CHUNK[section]);
      try {
        const res = await call<{ written?: { daily?: number; share_rows?: number; picks?: number }; problems?: { section: string; index: number; error: string }[] }>(
          ctx.api,
          {
            method: "POST",
            path: "/engagement/import",
            body: { dry_run: false, [section]: chunk },
            headers: { "Idempotency-Key": `import-engagement-${sha256(section + JSON.stringify(chunk))}` },
          },
          state.hardDeadline,
        );
        const w = res.data?.written ?? {};
        p.written.daily += w.daily ?? 0;
        p.written.share_rows += w.share_rows ?? 0;
        p.written.picks += w.picks ?? 0;
        for (const prob of res.data?.problems ?? []) {
          if (p.problems.length < 40) p.problems.push(`engagement.${prob.section}[${p[sentKey] + prob.index}]: ${prob.error}`);
        }
        p[sentKey] += chunk.length;
        await save(state, true);
      } catch (err) {
        if (isFatal(err)) throw err;
        if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while sending the engagement history`;
        p.error =
          err instanceof WritavoApiError && err.status === 404
            ? "this Site's API does not accept engagement history yet"
            : apiProblem(err);
        await save(state, true);
        return null;
      }
    }
  }
  p.done = true;
  await save(state, true);
  return null;
}

/**
 * The dry run's view of the engagement section: what it would set, per post in total, and which
 * rows point at no post (not in the document and not on the Site). Nothing is sent in a dry run:
 * the posts may not exist yet.
 */
function engagementDryRun(ctx: Loaded, byExternalId: Map<string, SiteArticle>, bySlug: Map<string, SiteArticle>): string[] {
  const e = ctx.engagement;
  if (e.daily.length === 0 && e.reactions.length === 0 && e.problems.length === 0) return [];
  const docIds = new Set(ctx.valid.map((v) => v.article.external_id));
  const docSlugs = new Set(ctx.valid.map((v) => v.article.slug).filter((x): x is string => Boolean(x)));
  const known = (row: { external_id?: string; slug?: string }) =>
    row.external_id !== undefined ? docIds.has(row.external_id) || byExternalId.has(row.external_id) : docSlugs.has(row.slug!) || bySlug.has(row.slug!);
  const orphanDaily = e.daily.filter((r) => !known(r)).length;
  const orphanPicks = e.reactions.filter((r) => !known(r)).length;
  const posts = new Set([...e.daily, ...e.reactions].map((r) => r.external_id ?? `slug:${r.slug}`));
  const sum = (f: (r: (typeof e.daily)[number]) => number) => e.daily.reduce((n, r) => n + f(r), 0);
  const views = sum((r) => r.views ?? 0);
  const reactions = sum((r) => (typeof r.reactions === "number" ? r.reactions : Object.values(r.reactions ?? {}).reduce((a: number, b) => a + (b ?? 0), 0)));
  const shares = sum((r) => Object.values(r.shares ?? {}).reduce((a: number, b) => a + (b ?? 0), 0));
  const lines = [
    "",
    `Engagement history: ${e.daily.length} daily rows and ${e.reactions.length} visitor reactions for ${posts.size} posts (views ${views}, daily reactions ${reactions}, shares ${shares}). Sent after every article is imported; each row SETS its post and day, replacing what that day held, so re-running never double-counts.`,
  ];
  if (orphanDaily || orphanPicks) {
    lines.push(`${orphanDaily + orphanPicks} engagement rows name a post that is neither in this document nor on the Site; they will be skipped.`);
  }
  if (e.problems.length) lines.push(`Engagement rows with problems, skipped (${e.problems.length}):`, ...listed(e.problems.map((x) => `- ${x}`), 20));
  return lines;
}

/** The engagement section's lines for an apply reply. */
function engagementReport(ctx: Loaded): string[] {
  const e = ctx.engagement;
  const p = ctx.progress.engagement;
  if (e.daily.length === 0 && e.reactions.length === 0 && e.problems.length === 0) return [];
  const lines = [""];
  if (p?.done && p.hash === engagementHash(e)) {
    lines.push(`Engagement history: delivered. Days written ${p.written.daily}, share rows ${p.written.share_rows}, visitor reactions ${p.written.picks}.`);
  } else if (p?.error) {
    lines.push(`Engagement history: NOT imported, because ${p.error}. The articles are not affected; run the import again later to send it.`);
  } else {
    lines.push(`Engagement history: ${p?.daily_sent ?? 0} of ${e.daily.length} daily rows and ${p?.reactions_sent ?? 0} of ${e.reactions.length} visitor reactions sent so far.`);
  }
  const skipped = [...e.problems, ...(p?.problems ?? [])];
  if (skipped.length) lines.push(`Engagement rows skipped (${skipped.length}):`, ...listed(skipped.map((x) => `- ${x}`), 20));
  return lines;
}

/**
 * The article's production cost in the old system, SET (replacing what an earlier import sent).
 * Kept apart from Writavo's own cost ledger by the API: never billed, never against a spend cap.
 * A failure here is the article's warning, not its failure: the article itself is written.
 */
async function sendCostHistory(state: ApplyState, articleId: string, entries: CostEntry[], warnings: string[]): Promise<void> {
  need(state, 1);
  try {
    const res = await call<{ imported_total_usd?: number; problems?: { index: number; error: string }[] }>(
      state.ctx.api,
      {
        method: "POST",
        path: `/articles/${encodeURIComponent(articleId)}/cost-history`,
        body: { entries },
        headers: { "Idempotency-Key": `import-costs-${sha256(articleId + JSON.stringify(entries))}` },
      },
      state.hardDeadline,
    );
    for (const p of res.data?.problems ?? []) warnings.push(`cost_history[${p.index}] was not imported: ${p.error}`);
  } catch (err) {
    if (isTransient(err) || isFatal(err)) throw err;
    warnings.push(
      err instanceof WritavoApiError && err.status === 404
        ? "its cost history was not imported: this Site's API does not accept cost history yet; run the import again later to add it"
        : `its cost history was not imported: ${apiProblem(err)}`,
    );
  }
}

async function apply(opts: ImportOptions, ctx: Loaded): Promise<ToolResult> {
  if (ctx.envelopeErrors.length > 0) {
    const invalidItems = ctx.items.filter((i) => i.errors.length > 0);
    return tagged("invalid", toolError(
      [
        `Nothing was written. ${ctx.source.label} has problems in its top level, and an import does not start until they are fixed:`,
        "",
        ...listed(ctx.envelopeErrors.map((e) => `- ${e}`)),
        ...(invalidItems.length
          ? ["", `Articles with problems (${invalidItems.length}):`, ...listed(invalidItems.map((i) => `- ${itemLabel(i)}: ${i.errors.join("; ")}`))]
          : []),
        "",
        "Fix them, run the dry run again, then apply.",
      ].join("\n"),
    ));
  }
  const mayTouchLive = opts.publish && opts.confirm;
  const pending = ctx.valid.filter((v) => !isSettled(ctx.progress.items[v.article.external_id], v, opts, mayTouchLive));
  const invalid = ctx.items.filter((i) => i.errors.length > 0);

  const toPublish = pending.filter((v) => v.article.status === "published").length;
  if (opts.publish && toPublish > 0 && !opts.confirm) {
    return tagged("needs_confirm", text(
      [
        "Nothing has been done. This import needs the user to confirm first.",
        "",
        `It publishes ${plural(toPublish, "article")} on the Site "${ctx.site.name}" with their original dates, where search engines and readers will see them, and updates to articles already live take effect immediately.${pending.length > toPublish ? ` Drafts imported as drafts: ${pending.length - toPublish}.` : ""}`,
        "",
        "Ask the user whether to go ahead. If they agree, call:",
        nextCall(ctx.source, opts, { confirm: true }),
        "To import everything as drafts instead, with nothing made public, pass publish: false.",
      ].join("\n"),
    ));
  }

  const state: ApplyState = {
    opts,
    ctx,
    deadline: (opts.startedAt ?? Date.now()) + (opts.budget ?? FOREGROUND_BUDGET).workMs,
    hardDeadline: (opts.startedAt ?? Date.now()) + (opts.budget ?? FOREGROUND_BUDGET).workMs + (opts.budget ?? FOREGROUND_BUDGET).graceMs,
    mayTouchLive,
    counts: { created: 0, updated: 0, published: 0, deferred: 0, skipped: 0, failed: 0, imagesCopied: 0, imagesFailed: 0 },
    problems: [],
    warnings: [],
    lastSave: Date.now(),
    saving: Promise.resolve(),
    extraRequests: 0,
  };

  let stopped: string | null = null;
  const termsStarted = Date.now();
  try {
    if (!(await ensureTaxonomy(state))) stopped = "this call's time or request budget ran out while creating categories, tags and authors";
  } catch (err) {
    if (err instanceof OutOfRequests) stopped = `${REQUEST_BUDGET_SPENT} while creating categories, tags and authors`;
    ctx.timing.terms = Date.now() - termsStarted;
    await save(state, true);
    if (err instanceof ItemProblem) return tagged("stopped", toolError(`import_content stopped: ${err.message}. Nothing after it was imported. ${progressNote(ctx)}`));
    if (err instanceof OutOfRequests) {
      // stopped is set above; nothing failed
    } else if (isTransient(err)) stopped = `the API was busy (${apiProblem(err)})`;
    else return tagged("stopped", stopReport(state, err));
  }
  ctx.timing.terms ||= Date.now() - termsStarted;

  let processed = 0;
  const articlesStarted = Date.now();
  if (!stopped) {
    for (const item of pending) {
      if (processed >= opts.batchSize) break;
      if (Date.now() > state.deadline) {
        stopped = "the time for this call ran out";
        break;
      }
      // Stop before an article that cannot finish in this call's request budget, rather than
      // part-way through it. The first article of a call always starts: its images are recorded
      // one by one, so a big one completes over several calls.
      const max = opts.budget?.maxRequests;
      if (max !== undefined && processed > 0) {
        const uncopied = opts.rehostImages
          ? articleImages(item.article).filter((i) => isHttps(i.url) && !ctx.progress.images[i.url]).length
          : 0;
        if (requestsUsed(state) + 6 + 4 * uncopied > max) {
          stopped = REQUEST_BUDGET_SPENT;
          break;
        }
      }
      processed += 1;
      const label = itemLabel(item.check);
      try {
        await processArticle(state, item);
      } catch (err) {
        if (err instanceof OutOfRequests) {
          stopped = REQUEST_BUDGET_SPENT;
          await save(state, true);
          break;
        }
        if (isFatal(err)) {
          ctx.timing.articles = Date.now() - articlesStarted;
          await save(state, true);
          return tagged("stopped", stopReport(state, err));
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
            await save(state, true);
            break;
          }
        } else {
          const reason = err instanceof ItemProblem ? err.message : apiProblem(err);
          record(state, item, { outcome: "failed", error: reason });
          state.counts.failed += 1;
          state.problems.push(`- ${label}: failed, ${reason}`);
        }
        await save(state);
      }
    }
  }
  if (processed > 0 || !stopped) ctx.timing.articles = Date.now() - articlesStarted;
  await save(state, true);

  // Counted as the NEXT call will see it, which does not pass retry_failed again.
  const nextOpts = { ...opts, retryFailed: false };
  const remaining = ctx.valid.filter((v) => !isSettled(ctx.progress.items[v.article.external_id], v, nextOpts, mayTouchLive)).length;
  // Engagement history goes after every article (it is keyed by the posts), in chunks, SET not add.
  if (remaining === 0 && !stopped && engagementPending(ctx)) {
    const why = await sendEngagement(state);
    if (why) stopped = why;
  }
  const engagementUnfinished = engagementPending(ctx) && !ctx.progress.engagement?.error;
  const allDone = remaining === 0 && !engagementUnfinished;
  const c = state.counts;
  const lines: string[] = [];
  const thisCall = `This call: created ${c.created}, updated ${c.updated}, published ${c.published}, left unchanged ${c.deferred}, skipped ${c.skipped}, failed ${c.failed}. Images copied ${c.imagesCopied}${c.imagesFailed ? `, not copied ${c.imagesFailed}` : ""}.`;
  const created = ctx.progress.created;

  if (allDone) {
    const entries = Object.entries(ctx.progress.items);
    const tally = (pred: (e: ProgressItem) => boolean) => entries.filter(([, e]) => pred(e)).length;
    lines.push(
      `Import complete for the Site "${ctx.site.name}". Every valid article in ${ctx.source.label} has been processed.`,
      "",
      thisCall,
      `${ctx.source.store ? "Across the whole import" : "Across this document"}: created ${tally((e) => e.action === "created")}, updated ${tally((e) => e.action === "updated")}, published ${tally((e) => e.published === true)}, left unchanged ${tally((e) => e.outcome === "deferred")}, skipped ${tally((e) => e.outcome === "skipped")}, failed ${tally((e) => e.outcome === "failed")}${invalid.length ? `, not imported because of problems in the document ${invalid.length}` : ""}. Categories created ${created.categories}, tags ${created.tags}, authors ${created.authors}, authors filled in ${ctx.progress.filled_authors}. Images copied ${Object.values(ctx.progress.images).filter((i) => i.url).length}.`,
    );
    const attention = entries
      .filter(([, e]) => e.outcome === "skipped" || e.outcome === "failed" || e.outcome === "deferred")
      .map(([id, e]) => `- ${id}: ${e.outcome}, ${e.error ?? "no reason recorded"}`);
    if (attention.length > 0) lines.push("", "Needs attention:", ...listed(attention));
    if (invalid.length > 0) {
      lines.push("", "Not imported because of problems in the document:", ...listed(invalid.map((i) => `- ${itemLabel(i)}: ${i.errors.join("; ")}`)));
    }
    if (state.warnings.length > 0) lines.push("", "Warnings from this call:", ...listed(state.warnings));
    lines.push(...engagementReport(ctx));
    lines.push(
      "",
      ctx.source.store
        ? `Progress is saved in ${ctx.source.store.location}. Running the same import again is safe: it changes nothing unless the file changed.`
        : "Sending the same document again is safe: articles are matched by external_id and updated, never duplicated.",
      "Next: verify with list_articles (for example status published, order published_at.desc, fields id,title,slug,published_at) that the counts, slugs and dates match the source. A draft's source dates are in original_published_at and original_content_updated_at, and its first publish from any path uses them.",
      ...(subMillisecondNote(ctx.valid) ? [subMillisecondNote(ctx.valid)!] : []),
    );
  } else {
    lines.push(
      remaining === 0
        ? `Every article is imported into the Site "${ctx.site.name}"; the engagement history is still being sent.`
        : `Imported a batch into the Site "${ctx.site.name}". ${ctx.valid.length - remaining} of ${ctx.valid.length} articles are done and ${remaining} remain.`,
      "",
      thisCall,
      `Categories created so far ${created.categories}, tags ${created.tags}, authors ${created.authors}.`,
    );
    if (stopped) lines.push(`Stopped early: ${stopped}.`);
    if (state.problems.length > 0) lines.push("", "Problems this call:", ...listed(state.problems));
    if (state.warnings.length > 0) lines.push("", "Warnings this call:", ...listed(state.warnings));
    lines.push(...engagementReport(ctx));
    if (ctx.source.store) {
      lines.push(
        "",
        progressNote(ctx),
        "Next: call import_content again with the same arguments to continue:",
        nextCall(ctx.source, opts, { ...(opts.confirm ? { confirm: true } : {}) }),
      );
    } else {
      // Inline data has no progress file, so sending the whole document again would redo the
      // articles already done before reaching new ones. The model is told exactly what is left.
      const left = ctx.valid
        .filter((v) => !isSettled(ctx.progress.items[v.article.external_id], v, nextOpts, mayTouchLive))
        .map((v) => v.article.external_id);
      lines.push(
        "",
        progressNote(ctx),
        `Next: call import_content again with a document holding ONLY the articles not yet done (keep the authors, categories and tags they use), with ${JSON.stringify({ dry_run: false, ...(opts.confirm ? { confirm: true } : {}), ...(opts.publish ? {} : { publish: false }), ...(opts.rehostImages ? {} : { rehost_images: false }) })}. Still to do (${left.length}):`,
        ...listed(left.map((id) => `- ${id}`), 60),
      );
    }
  }
  lines.push("", timingLine(ctx.timing, ctx.api.stats));
  return tagged(allDone ? "complete" : "partial", text(lines.join("\n")));
}

/** A failure no other article can get past: the API's own guidance, then where the import stands. */
function stopReport(state: ApplyState, err: unknown): ToolResult {
  const guidance = formatApiError(err, { tool: "import_content" }).content.map((c) => c.text).join("\n");
  const c = state.counts;
  return toolError(
    [
      guidance,
      "",
      `Before it stopped, this call created ${c.created}, updated ${c.updated} and published ${c.published} articles. ${progressNote(state.ctx)} Fix the cause and call import_content again to carry on from there.`,
      "",
      timingLine(state.ctx.timing, state.ctx.api.stats),
    ].join("\n"),
  );
}

/**
 * What an apply call came to, for a caller that acts on it (the background runner): the reply
 * text is for people, this is for code.
 *   complete       every valid article is settled
 *   partial        work remains; call again
 *   busy           another call holds the import; nothing was done
 *   needs_confirm  it would publish, and confirm was not given; nothing was done
 *   invalid        the document or the Site refused it before any write
 *   stopped        a failure no retry gets past (a revoked key, no payment method)
 */
export type ImportRunStatus = "complete" | "partial" | "busy" | "needs_confirm" | "invalid" | "stopped";

export type ImportResult = ToolResult & { importStatus?: ImportRunStatus };

function tagged(status: ImportRunStatus, result: ToolResult): ImportResult {
  return Object.assign(result, { importStatus: status });
}

/** Where an import stands, from its progress: for status replies. */
export interface ImportProgressSummary {
  articles_total: number;
  articles_done: number;
  articles_failed: number;
  articles_skipped: number;
  images_copied: number;
  images_failed: number;
  categories_created: number;
  tags_created: number;
  authors_created: number;
}

export function summariseProgress(progress: ImportProgress | null, articlesTotal: number): ImportProgressSummary {
  const items = Object.values(progress?.items ?? {});
  const images = Object.values(progress?.images ?? {});
  return {
    articles_total: articlesTotal,
    articles_done: items.filter((i) => i.outcome === "done" || i.outcome === "deferred").length,
    articles_failed: items.filter((i) => i.outcome === "failed").length,
    articles_skipped: items.filter((i) => i.outcome === "skipped").length,
    images_copied: images.filter((i) => i.url).length,
    images_failed: images.filter((i) => i.error).length,
    categories_created: progress?.created.categories ?? 0,
    tags_created: progress?.created.tags ?? 0,
    authors_created: progress?.created.authors ?? 0,
  };
}

export async function runImport(apiContext: ToolContext, source: ImportSource, opts: ImportOptions): Promise<ImportResult> {
  // This call's own tally of API requests (timingLine) and its hard end, never shared.
  const budget = opts.budget ?? FOREGROUND_BUDGET;
  const startedAt = opts.startedAt ?? Date.now();
  opts = { ...opts, startedAt, budget };
  const api: ToolContext = { ...apiContext, stats: newApiStats(), deadline: startedAt + budget.workMs + budget.graceMs };
  if (opts.dryRun) {
    const loaded = await load(api, source);
    return "content" in loaded ? loaded : dryRun(opts, loaded);
  }
  const busy = (until: number | null) => {
    const wait = until === null ? null : Math.max(1, Math.ceil((until - Date.now()) / 1000));
    return text(
      `An import of ${source.label} from an earlier call is still running. Nothing new was started. ` +
        (wait === null
          ? "Wait a few seconds and call import_content again with the same arguments."
          : `Its hold ends by ${new Date(until!).toISOString()} at the latest, in about ${wait} seconds (sooner if that call finishes first). Call import_content again with the same arguments after that.`),
    );
  };
  // A client that gave up waiting on a call can send the next one while the first is still
  // working; two batches racing over one stored progress would each record half of what happened.
  // Nothing would be duplicated (every write is idempotent), but the second call is refused
  // anyway, because there is nothing useful for it to do yet.
  if (source.lease) {
    const held = await source.lease.acquire();
    if (!held.ok) return tagged("busy", busy(held.until));
  }
  try {
    const loaded = await load(api, source);
    return "content" in loaded ? tagged("invalid", loaded) : await apply(opts, loaded);
  } finally {
    await source.lease?.release().catch(() => undefined);
  }
}
