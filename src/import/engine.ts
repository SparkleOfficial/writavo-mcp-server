import { createHash } from "node:crypto";
import { WritavoApiError } from "../api/client.js";
import { MediaError, fetchImage, uploadImage } from "../api/media.js";
import { newApiStats, type ApiStats, type ToolContext } from "../core/context.js";
import { formatApiError, text, toolError, type ToolResult } from "../errors.js";
import { SCOPE_SCREEN } from "../generated/scopes.js";
import { howtoSteps, type CostEntry, type ImportArticle, type ImportComment, type ImportAuthor, type ImportEntry, type ImportEnvelope, type ImportTerm } from "./format.js";
import { articleImages, htmlImageCount, isHttps, rewriteMarkdownImages } from "./images.js";
import { newProgress, type ImportProgress, type ProgressItem, type ProgressStore } from "./progress.js";
import {
  ARTICLE_STATE_FIELDS,
  call,
  findByExternalId,
  findBySlug,
  findEntryByExternalId,
  getArticleState,
  getSite,
  isTransient,
  listAll,
  type SiteArticle,
  type SiteAuthor,
  type SiteFormat,
  type SiteInfo,
  type SiteTerm,
} from "./site.js";
import { checkDocument, itemLabel, seoKeywordKey, type CommentsCheck, type ContentTypesCheck, type EngagementCheck, type EntriesCheck, type ItemCheck, type ProfileCheck, type RedirectsCheck, type SeoCheck } from "./validate.js";

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
  /** The comments section's valid rows, in sending order, and skipped-row problems (validate.ts). */
  comments: CommentsCheck;
  /** The SEO section's valid rows and skipped-row problems (validate.ts). */
  seo: SeoCheck;
  /** The redirects section's valid rows and skipped-row problems (validate.ts). */
  redirects: RedirectsCheck;
  /** The content_types and entries sections (0136). */
  contentTypes: ContentTypesCheck;
  entries: EntriesCheck;
  /** The AI writing profile section, its prompt variable names checked against the Site. */
  profile: ProfileCheck;
  /** The Site's profile as GET /site/knowledge-profile returned it, or why it could not be read.
   *  Read only when the document has a profile section (the dry run reads it either way). */
  siteProfile?: SiteProfile | string;
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
/**
 * What a run does to an article after writing it: publish it (a post live at the source), schedule
 * it (a post scheduled at the source, whose time is still ahead), or nothing (a draft, or any
 * article while publish is false). A scheduled post whose time has passed is left a draft: the
 * API refuses a schedule in the past, and publishing it now would date it today.
 */
export function lifecycleOf(article: ImportArticle, opts: Pick<ImportOptions, "publish">, now = Date.now()): "publish" | "schedule" | null {
  if (!opts.publish) return null;
  if (article.status === "published") return "publish";
  if (article.status === "scheduled" && Date.parse(article.scheduled_at) > now) return "schedule";
  return null;
}

function isSettled(entry: ProgressItem | undefined, item: ValidItem, opts: ImportOptions, mayTouchLive: boolean): boolean {
  if (!entry || entry.hash !== item.hash) return false;
  switch (entry.outcome) {
    case "done":
      // `published` records that the article's lifecycle step (publish or schedule) is done.
      return lifecycleOf(item.article, opts) === null || entry.published === true;
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
  // A converted export's notes (the WordPress importer's report) join each article's own warnings,
  // so the dry run and the apply report them beside the article they concern.
  const conversionNotes = envelope.conversion?.items ?? {};
  for (const item of checked.items) {
    const notes = item.externalId ? conversionNotes[item.externalId] : undefined;
    if (notes?.length) item.warnings.unshift(...notes);
  }

  let site: SiteInfo;
  let siteCategories: Map<string, string>;
  let siteTags: Map<string, string>;
  let siteAuthors: SiteAuthors;
  let formats: Map<string, string>;
  let siteTypes: Set<string> | null = null;
  try {
    site = await getSite(api);
    const [categories, tags, authors, types] = await Promise.all([
      listAll<SiteTerm>(api, "/categories", [["fields", "id,name,slug"]]),
      listAll<SiteTerm>(api, "/tags", [["fields", "id,name,slug"]]),
      listAll<SiteAuthor>(api, "/authors", [["fields", AUTHOR_FIELDS]]),
      call<{ items: SiteFormat[] }>(api, { method: "GET", path: "/formats" }),
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
  // The Site's content types, only when the document has entries (0136). A Site or key that cannot
  // read them leaves the check to the API (each entry of an unknown type then fails on its own).
  if ((checked.entries.rows.length ?? 0) > 0) {
    try {
      const types = await call<{ items: Array<{ api_id: string; kind: string }> }>(api, { method: "GET", path: "/content-types" });
      siteTypes = new Set((types.data?.items ?? []).filter((t) => t.kind === "collection" || t.kind === "singleton").map((t) => t.api_id));
    } catch {
      siteTypes = null;
    }
  }

  // The AI writing profile: its prompt variable names are the Site's to define, so a name the Site
  // does not know is reported and left out here rather than refusing the whole section later.
  let siteProfile: SiteProfile | string | undefined;
  if (checked.profile.profile) {
    siteProfile = await readSiteProfile(api);
    if (typeof siteProfile !== "string") checkProfileVars(checked.profile, siteProfile);
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

  // An entry must be of a type the document creates or the Site already has.
  if (siteTypes) {
    const fileTypes = new Set(checked.contentTypes.types.filter((t) => (t.kind ?? "collection") === "collection" || t.kind === "singleton").map((t) => t.api_id));
    const kept = checked.entries.rows.filter((e) => fileTypes.has(e.type) || siteTypes!.has(e.type));
    for (const e of checked.entries.rows) {
      if (!kept.includes(e)) checked.entries.problems.push(`entry ${e.external_id}: "${e.type}" is not a content type with entries in content_types[] or on the Site`);
    }
    checked.entries.rows = kept;
  }

  return {
    api,
    source,
    envelope,
    envelopeErrors: checked.envelopeErrors,
    engagement: checked.engagement,
    comments: checked.comments,
    seo: checked.seo,
    redirects: checked.redirects,
    contentTypes: checked.contentTypes,
    entries: checked.entries,
    profile: checked.profile,
    siteProfile,
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
  const counts = { create: 0, update: 0, done: 0, unchangedLive: 0, costOnLive: 0, publish: 0, schedule: 0, blocked: 0 };
  const warnings: string[] = [];
  const pending: ValidItem[] = [];

  for (const item of valid) {
    const { article } = item;
    const label = itemLabel(item.check);
    for (const w of item.check.warnings) warnings.push(`- ${label}: ${w}`);
    // Cost history is not public content, so it is written for an article that is live and left
    // unchanged too (publish false): counted whether or not the article itself is settled.
    if (!opts.publish && article.cost_history !== undefined && byExternalId.get(article.external_id)?.status === "published") {
      const entry = progress.items[article.external_id];
      const p = progress.cost_history?.[article.external_id];
      const sentBefore = entry && entry.hash === item.hash && entry.outcome === "done";
      if (!sentBefore && !(p && p.done && p.hash === costHash(article.cost_history))) counts.costOnLive += 1;
    }
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
    if (lifecycleOf(article, opts) === "schedule") {
      if (existing?.status === "published") {
        warnings.push(`- ${label}: is already live on the Site, so it is not scheduled`);
      } else {
        counts.schedule += 1;
      }
    } else if (article.status === "published" && opts.publish) {
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
  const scheduled = valid.filter((v) => v.article.status === "scheduled").length;

  const lines = [
    `Dry run of ${ctx.source.label} for the Site "${site.name}". Nothing was written.`,
    "",
    ...(envelope.conversion?.lines.length ? [...envelope.conversion.lines, ""] : []),
    `Articles in the file: ${ctx.items.length} (${published} published, ${scheduled ? `${scheduled} scheduled, ` : ""}${plural(valid.length - published - scheduled, "draft")}${invalid.length ? `, ${invalid.length} with problems` : ""}).`,
    `- create: ${counts.create}`,
    `- update: ${counts.update} (already on the Site with the same external_id; one whose content matches the file exactly is left as it is, with no new revision or webhook)`,
    ...(counts.done ? [`- already done by an earlier run: ${counts.done}`] : []),
    ...(counts.unchangedLive ? [`- left unchanged because they are live and publish is false: ${counts.unchangedLive}`] : []),
    ...(counts.costOnLive
      ? [`- cost history to write on live articles: ${counts.costOnLive} (publish is false, so their content stays as it is; cost history is never shown publicly, so it is written anyway)`]
      : []),
    `- blocked by a problem below: ${counts.blocked}`,
    opts.publish
      ? `- to publish with their original dates: ${counts.publish}`
      : "- to publish: none, because publish is false (everything is imported as a draft)",
    ...(opts.publish && counts.schedule ? [`- to schedule for their future dates: ${counts.schedule}`] : []),
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
  lines.push(...(await contentTypesDryRun(ctx)));
  lines.push(...entriesDryRun(ctx, opts));
  const withCustomFields = customFieldItems(ctx).length;
  if (withCustomFields) lines.push("", `Articles' custom fields: ${withCustomFields} articles carry them; set after every entry exists, with their references and media resolved.`);
  lines.push(...redirectsDryRun(ctx));
  lines.push(...engagementDryRun(ctx, byExternalId, bySlug));
  lines.push(...commentsDryRun(ctx, byExternalId, bySlug));
  lines.push(...(await seoDryRun(ctx)));
  lines.push(...(await profileDryRun(ctx)));

  // What the apply will still write beyond articles, and the permissions all of it needs.
  const otherWork: string[] = [];
  if (counts.costOnLive) otherWork.push(`cost history on ${plural(counts.costOnLive, "live article")}`);
  if (engagementPending(ctx)) otherWork.push("the engagement history");
  if (commentsPending(ctx)) otherWork.push("the reader comments");
  if (seoPending(ctx)) otherWork.push("the SEO data");
  if (redirectsPending(ctx)) otherWork.push("redirects");
  if (contentTypesPending(ctx)) otherWork.push("content types");
  if (entriesPending(ctx)) otherWork.push("entries");
  if (profilePending(ctx)) otherWork.push("the AI writing profile");
  const needs = new Map<string, string>();
  if (pending.length > 0) needs.set("articles:write", "writing articles");
  else if (counts.costOnLive) needs.set("articles:write", "cost history");
  else if (redirectsPending(ctx)) needs.set("articles:write", "redirects");
  if (categoriesToCreate.length + tagsToCreate.length > 0) needs.set("taxonomy:write", "creating categories and tags");
  if (authorsToCreate.length + authorsToFill.length > 0) needs.set("authors:write", "creating and filling in authors");
  if (opts.rehostImages && toCopy.size > 0) needs.set("media:write", "copying images into the media library");
  if (engagementPending(ctx)) needs.set("engagement:write", "the engagement history");
  if (commentsPending(ctx)) needs.set("comments:write", "the reader comments");
  if (seoPending(ctx)) needs.set("seo:write", "the SEO data: keywords, competitors and ranking history");
  if (contentTypesPending(ctx)) needs.set("content_types:write", "content types");
  if (entriesPending(ctx)) needs.set("entries:write", "entries");
  if (profilePending(ctx)) needs.set("site:write", "the AI writing profile");
  const missingScopes = await scopeReport(ctx, needs, lines);
  // "Migrate a blog" deliberately leaves Reader comments off (the queue carries commenters' email
  // addresses), so the general advice above does not cover it: say exactly what does.
  if (missingScopes.includes("comments:write")) {
    lines.push(`Reader comments are not part of "Migrate a blog" (that row is opt-in). ${COMMENTS_SCOPE_ADVICE}. Applied without it, everything else is imported and the comments are reported as skipped.`);
  }

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
    if (invalid.length > 0) {
      lines.push("No article is left to import. Fix the problems above and run the dry run again.");
    } else if (otherWork.length === 0) {
      lines.push("Nothing to import: everything in the document is already on the Site.");
    } else {
      lines.push(`No article needs writing, but this import still has work to do: ${otherWork.join(", ")}.`);
    }
    if (otherWork.length > 0) {
      lines.push(
        ...(missingScopes.length ? [`Grant ${missingScopes.join(", ")} first (see above); without it that part is reported and skipped.`] : []),
        "To apply, call:",
        nextCall(ctx.source, opts, {}),
        ctx.source.store
          ? "Then call it again with the same arguments until it reports the import is complete."
          : "If a call stops before the end, it says what is left.",
      );
    }
  } else {
    const needsConfirm = opts.publish && pending.some((p) => lifecycleOf(p.article, opts) !== null);
    if (invalid.length > 0) {
      lines.push("Fix the problems above in the document and run the dry run again. Or apply now: the articles with problems are skipped and reported, and everything else is imported.");
    }
    if (missingScopes.length) {
      lines.push(`Grant ${missingScopes.join(", ")} first (see above), or apply anyway: what this connection may do is imported and the rest is reported as refused.`);
    }
    lines.push(
      needsConfirm
        ? `To apply, first ask the user: this publishes ${plural(counts.publish, "article")} on their live site with their original dates${counts.schedule ? `, schedules ${plural(counts.schedule, "article")} to go live at their scheduled times` : ""}${counts.update ? `, and updates to articles already live take effect immediately` : ""}. If they agree, call:`
        : "To apply, call:",
      nextCall(ctx.source, opts, needsConfirm ? { confirm: true } : {}),
      ctx.source.store
        ? "Then call it again with the same arguments until it reports the import is complete."
        : "If a call stops before the end, it lists the articles still to do; send only those in the next call.",
    );
  }
  return text(lines.join("\n"));
}

/**
 * Every scope a whole-blog migration writes with: articles (+ engagement history), entries (+
 * content types), categories, tags and authors, media, Site settings (the AI writing profile) and
 * SEO (keywords, competitors, ranking history). The dashboard's "Migrate a blog" permission
 * shortcut grants exactly these (apps/dashboard/lib/agents.ts MIGRATION_WRITE_AREAS). Asked for
 * up front, so a migration is never stopped halfway by a permission it could have asked for.
 * comments:write is deliberately not one of them: Reader comments is an opt-in row (the queue
 * carries commenters' email addresses), so an import without it reports how to turn it on.
 */
export const MIGRATION_SCOPES: readonly string[] = [
  "articles:write", "engagement:write", "entries:write", "content_types:write", "taxonomy:write",
  "authors:write", "media:write", "site:read", "site:write", "seo:write",
];

/**
 * The permissions the apply will need, against what this connection carries (GET /ping). Pushes
 * its lines onto `lines` and returns the scopes that are missing. A connection that cannot be
 * read is reported as unchecked, never as fine.
 */
async function scopeReport(ctx: Loaded, needs: Map<string, string>, lines: string[]): Promise<string[]> {
  if (needs.size === 0) return [];
  const list = [...needs].map(([scope, why]) => `${scope} (${why})`).join(", ");
  let carried: string[];
  try {
    const res = await call<{ scopes?: string[] }>(ctx.api, { method: "GET", path: "/ping" });
    carried = res.data?.scopes ?? [];
  } catch (err) {
    lines.push("", `Permissions this import needs: ${list}. This connection's permissions could not be read (${apiProblem(err)}), so they were not checked.`);
    return [];
  }
  const missing = [...needs.keys()].filter((scope) => !carried.includes(scope));
  lines.push("", `Permissions this import needs: ${list}.`);
  if (missing.length === 0) {
    lines.push("This connection has all of them.");
    return [];
  }
  lines.push(
    `MISSING on this connection: ${missing.join(", ")}. That part will be refused until it is granted.`,
    ...missing.map((scope) => `- ${scope}: on the sign-in screen, ${SCOPE_SCREEN[scope] ?? "ask the person who owns the Site"}.`),
    "To grant it without signing in again, the person opens Settings > AI agents (https://app.writavo.com/settings/agents), finds this connection and adds the permission (Permissions, or the Add button), then runs the dry run again. The \"Migrate a blog\" button there grants everything a whole-blog move needs in one step, so nothing else stops the import later. Or they reconnect Writavo in this AI client and choose \"Migrate a blog\" on the sign-in screen. verify_api_key lists what the connection carries.",
  );
  return missing;
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
  counts: { created: number; updated: number; unchanged: number; published: number; scheduled: number; deferred: number; skipped: number; failed: number; imagesCopied: number; imagesFailed: number };
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
  return (await rehostAsset(state, url, alt, bucket, warnings, false))?.url;
}

/** Copy one image and return its media library entry. `needId`: a copy recorded before ids were
 *  kept (0136) is made again, because a media field needs the id. */
async function rehostAsset(
  state: ApplyState,
  url: string,
  alt: string | undefined,
  bucket: "blog-images" | "author-avatars",
  warnings: string[],
  needId: boolean,
): Promise<{ url: string; id?: string } | undefined> {
  const { progress } = state.ctx;
  if (!isHttps(url)) {
    warnings.push(`image ${url} is not https, so it keeps its original URL`);
    return undefined;
  }
  const known = progress.images[url];
  if (known?.url && (known.id || !needId)) return { url: known.url, id: known.id };
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
    const id = typeof asset.id === "string" ? asset.id : undefined;
    progress.images[url] = { url: hosted, ...(id ? { id } : {}) };
    state.counts.imagesCopied += 1;
    return { url: hosted, id };
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

  // 0129: nested categories. Once every category exists, each one whose file entry names a parent
  // gets it, when it has none on the Site yet (an existing parent is never changed). One list
  // read, then a PATCH only where something is missing, so a re-run changes nothing.
  const nested = (envelope.categories ?? []).filter((c) => c.parent && c.parent !== c.slug);
  if (nested.length) {
    if (Date.now() > state.deadline) return false;
    const onSite = new Map(
      (await listAll<SiteTerm & { parent_id?: string | null }>(ctx.api, "/categories", [["fields", "id,slug,parent_id"]])).map((t) => [t.slug, t]),
    );
    for (const c of nested) {
      const self = onSite.get(c.slug);
      const parentId = progress.categories[c.parent!] ?? ctx.siteCategories.get(c.parent!) ?? onSite.get(c.parent!)?.id;
      if (!self || self.parent_id || !parentId) {
        if (self && !self.parent_id && !parentId) state.warnings.push(`- category "${c.slug}": its parent "${c.parent}" is not on the Site, so it stays at the top level`);
        continue;
      }
      if (Date.now() > state.deadline) return false;
      try {
        await call(ctx.api, { method: "PATCH", path: `/categories/${self.id}`, body: { parent_id: parentId } }, state.hardDeadline);
      } catch (err) {
        if (!(err instanceof WritavoApiError && err.status === 422)) throw err;
        state.warnings.push(`- category "${c.slug}": its parent "${c.parent}" was refused (${err.message}); it stays at the top level`);
      }
    }
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
  if (article.kind !== undefined) body.article_kind = article.kind;
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
  // 0128: the SEO overrides. The social image is copied into the media library like the featured one.
  if (article.canonical_url !== undefined) body.canonical_url = article.canonical_url;
  if (article.noindex !== undefined) body.noindex = article.noindex;
  if (article.og_title !== undefined) body.og_title = article.og_title;
  if (article.og_description !== undefined) body.og_description = article.og_description;
  if (article.og_image !== undefined) {
    body.og_image_url = article.og_image === null ? null : (imageUrl(article.og_image.url) ?? article.og_image.url);
    body.og_image_alt = article.og_image === null ? null : (article.og_image.alt ?? null);
  }
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
    // 0129: the other categories, as the full set (the API files it under the primary first).
    if (article.categories?.length) {
      const others = article.categories.filter((c) => c !== article.category).map((c) => {
        const other = progress.categories[c] ?? ctx.siteCategories.get(c);
        if (!other) throw new ItemProblem(`category "${c}" is not on the Site`);
        return other;
      });
      body.category_ids = [id, ...others];
    }
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
  const lifecycle = lifecycleOf(article, opts);
  const needsPublish = lifecycle !== null;
  const warnings: string[] = [...item.check.warnings];

  let articleId = previous && previous.hash === item.hash && previous.action ? previous.article_id : undefined;
  let current: SiteArticle | null = null;

  if (!articleId) {
    // Find the article FIRST: one that is live and left unchanged must not cost a single image
    // copy (the dry run counts none for it, and an apply that copied them left orphan duplicates).
    need(state, 1);
    current = await findByExternalId(ctx.api, article.external_id, state.hardDeadline);
    if (current && current.status === "published" && !state.mayTouchLive) {
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
    if (opts.rehostImages) {
      await inPool(articleImages(article), IMAGE_CONCURRENCY, async (image) => {
        await rehost(state, image.url, image.alt, "blog-images", warnings);
      });
      await save(state);
    }
    const body = buildBody(article, ctx, (url) => (opts.rehostImages ? ctx.progress.images[url]?.url : undefined));

    // write, read back (+ publish, re-read) (+ the cost history), reserved before the write so
    // the article is never recorded done with its cost history still unsent
    need(state, (needsPublish ? 4 : 2) + (article.cost_history !== undefined ? 1 : 0));
    let action: "created" | "updated";
    if (current) {
      if (current.status === "published" && article.slug && current.slug && current.slug !== article.slug) {
        warnings.push(`its live URL changed from /${current.slug} to /${article.slug}; nothing redirects the old one`);
      }
      // The API writes nothing when the body matches what is stored (Writavo-Unchanged), so a re-run
      // of an unchanged file makes no edits, revisions or webhooks, and says so.
      const patched = await call(ctx.api, { method: "PATCH", path: `/articles/${encodeURIComponent(current.id)}`, body }, state.hardDeadline);
      articleId = current.id;
      action = "updated";
      if (patched.unchanged) state.counts.unchanged += 1;
      else state.counts.updated += 1;
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

  if (lifecycle === "schedule" && !(previous && previous.hash === item.hash && previous.published)) {
    current ??= await getArticleState(ctx.api, articleId!, state.hardDeadline);
    if (current.status === "published") {
      // Live already (published by hand, or by an earlier import): scheduling would be refused.
      warnings.push("it is already live on the Site, so it was not scheduled");
    } else {
      await call(
        ctx.api,
        {
          method: "POST",
          path: `/articles/${encodeURIComponent(articleId!)}/schedule`,
          body: { scheduled_publish_at: article.status === "scheduled" ? article.scheduled_at : undefined },
        },
        state.hardDeadline,
      );
      state.counts.scheduled += 1;
    }
    record(state, item, { outcome: "done", article_id: articleId, published: true, error: undefined, warnings });
  } else if (lifecycle === "publish" && !(previous && previous.hash === item.hash && previous.published)) {
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

/**
 * v2: picks are sent BEFORE daily rows. The API applies a pick as +1 on its day and a daily row as
 * SET, so the daily rows must land last, or every imported pick is counted twice (once in the
 * day's total, once by the pick). v1 sent daily first; the version in the hash makes a section v1
 * delivered be sent once more, which repairs it: identical picks are a no-op, daily rows SET.
 */
function engagementHash(e: EngagementCheck): string {
  return sha256(JSON.stringify({ v: 2, d: e.daily, r: e.reactions }));
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
  // Picks first, daily rows last (see engagementHash). A section is only ever resumed in this order.
  for (const section of ["reactions", "daily"] as const) {
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

// ---------------------------------------------------------------------------
// Reader comments (the document's optional comments section, POST /comments/import, 0160)
// ---------------------------------------------------------------------------
/** The API's caps on one POST /comments/import: 2,000 rows, a body of about 8 MB. A chunk stops
 *  at either, with room to spare under the body limit. */
export const COMMENTS_CHUNK = { rows: 2_000, bytes: 6 * 1024 * 1024 } as const;

/** What to do when the connection lacks comments:write: the opt-in row, on the same connection. */
export const COMMENTS_SCOPE_ADVICE =
  "Turn on Reader comments for this connection in Writavo > Settings > AI agents (for an import started from the dashboard's Import page, the person running it needs the Moderate comments permission), then run the import again; articles already imported are not duplicated";
const COMMENTS_SCOPE_MISSING = `this connection lacks comments:write (${SCOPE_SCREEN["comments:write"]?.replace(/ \(.*$/, "") ?? "Reader comments, Read and moderate"})`;

interface CommentsImportReply {
  dry_run?: boolean;
  written?: { created?: number; updated?: number };
  problems?: { index: number; external_id?: string; problem: string }[];
}

/** v1: rows in sending order (validate.ts orderComments), so a changed order is a changed section. */
function commentsHash(c: CommentsCheck): string {
  return sha256(JSON.stringify({ v: 1, rows: c.rows }));
}

/** The section has rows that have not all been delivered, as the document now has them. */
function commentsPending(ctx: Loaded): boolean {
  if (ctx.comments.rows.length === 0) return false;
  const p = ctx.progress.comments;
  return !(p && p.hash === commentsHash(ctx.comments) && p.done);
}

/** A row as the API takes it: what the document left null is left out. */
function commentWire(c: ImportComment): Record<string, unknown> {
  return Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined));
}

const utf8 = new TextEncoder();

/**
 * The next chunk of `rows` from `from`: at most COMMENTS_CHUNK.rows rows and COMMENTS_CHUNK.bytes of
 * JSON, and always at least one row. Rows go in order, so a reply is never in an earlier chunk than
 * its parent (orderComments put every parent first).
 */
export function nextCommentChunk(rows: ImportComment[], from: number, limits: { rows: number; bytes: number } = COMMENTS_CHUNK): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let bytes = 64;
  for (let i = from; i < rows.length && out.length < limits.rows; i += 1) {
    const wire = commentWire(rows[i]!);
    const size = utf8.encode(JSON.stringify(wire)).length + 1;
    if (out.length > 0 && bytes + size > limits.bytes) break;
    out.push(wire);
    bytes += size;
  }
  return out;
}

/**
 * Send what is left of the section, a chunk per request. Comments are SET on their external_id, so
 * a chunk sent twice changes nothing. A reason to stop (time, requests, a busy API), or null when
 * this call finished (delivered, or refused for a reason recorded in progress.comments.error, which
 * the next apply retries). A missing comments:write is recorded, not fatal: the articles do not
 * need it, and the opt-in Reader comments row is not part of "Migrate a blog".
 */
async function sendComments(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const rows = ctx.comments.rows;
  const hash = commentsHash(ctx.comments);
  if (!ctx.progress.comments || ctx.progress.comments.hash !== hash) {
    ctx.progress.comments = { hash, started: new Date().toISOString(), sent: 0, done: false, written: { created: 0, updated: 0 }, problems: [], problem_count: 0 };
  }
  const p = ctx.progress.comments;
  delete p.error;
  while (p.sent < rows.length) {
    if (Date.now() > state.deadline) return "the time for this call ran out while sending the reader comments";
    const max = state.opts.budget?.maxRequests;
    if (max !== undefined && requestsUsed(state) + 1 > max) return REQUEST_BUDGET_SPENT;
    const chunk = nextCommentChunk(rows, p.sent);
    try {
      const res = await call<CommentsImportReply>(
        ctx.api,
        {
          method: "POST",
          path: "/comments/import",
          body: { dry_run: false, comments: chunk },
          // The delivery's start is in the key: a resumed chunk replays safely, while a delivery
          // started again (a changed section, retry_failed, a refusal now fixed) is new work.
          headers: { "Idempotency-Key": `import-comments-${sha256(`${p.started}|${hash}|${JSON.stringify(chunk)}`)}` },
        },
        state.hardDeadline,
      );
      p.written.created += res.data?.written?.created ?? 0;
      p.written.updated += res.data?.written?.updated ?? 0;
      for (const prob of res.data?.problems ?? []) {
        p.problem_count += 1;
        const id = prob.external_id || String(chunk[prob.index]?.external_id ?? `#${p.sent + prob.index}`);
        if (p.problems.length < 40) p.problems.push(`comment ${id}: ${prob.problem}`);
      }
      p.sent += chunk.length;
      await save(state, true);
    } catch (err) {
      if (isFatal(err) && err.code !== "INSUFFICIENT_SCOPE") throw err;
      if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while sending the reader comments`;
      p.error =
        err instanceof WritavoApiError && err.code === "INSUFFICIENT_SCOPE"
          ? `${COMMENTS_SCOPE_MISSING}. ${COMMENTS_SCOPE_ADVICE}`
          : err instanceof WritavoApiError && err.status === 404
            ? "this Site's API does not accept comments yet"
            : apiProblem(err);
      // Fresh keys for the next attempt, so a refusal is never replayed once its cause is fixed.
      p.started = new Date().toISOString();
      await save(state, true);
      return null;
    }
  }
  p.done = true;
  await save(state, true);
  return null;
}

/**
 * The dry run's view of the comments section: what it carries, and which rows point at no post
 * (not in the document and not on the Site). Nothing is sent in a dry run: the posts may not exist
 * yet, and a parent in this document is only on the Site once the apply sends it.
 */
function commentsDryRun(ctx: Loaded, byExternalId: Map<string, SiteArticle>, bySlug: Map<string, SiteArticle>): string[] {
  const c = ctx.comments;
  if (c.rows.length === 0 && c.problems.length === 0) return [];
  const docIds = new Set(ctx.valid.map((v) => v.article.external_id));
  const docSlugs = new Set(ctx.valid.map((v) => v.article.slug).filter((x): x is string => Boolean(x)));
  const known = (row: ImportComment) =>
    row.post_external_id != null ? docIds.has(row.post_external_id) || byExternalId.has(row.post_external_id) : docSlugs.has(row.post_slug!) || bySlug.has(row.post_slug!);
  const status = (s: string) => c.rows.filter((r) => (r.status ?? "approved") === s).length;
  const ids = new Set(c.rows.map((r) => r.external_id));
  const replies = c.rows.filter((r) => r.parent_external_id != null).length;
  const outside = c.rows.filter((r) => r.parent_external_id != null && !ids.has(r.parent_external_id)).length;
  const orphans = c.rows.filter((r) => !known(r)).length;
  const posts = new Set(c.rows.map((r) => r.post_external_id ?? `slug:${r.post_slug}`)).size;
  const lines = [
    "",
    `Reader comments: ${c.rows.length} (${status("approved")} approved, ${status("pending")} pending, ${status("spam")} spam) on ${plural(posts, "post")}, ${replies} of them replies. Sent after every article, up to ${COMMENTS_CHUNK.rows} a call, every parent before its replies; matched on external_id, so re-running updates them and never duplicates. Imported comments notify nobody.`,
  ];
  if (c.rows.length > 0 && !commentsPending(ctx)) lines.push("Reader comments: already delivered by an earlier run.");
  if (orphans) lines.push(`${plural(orphans, "comment")} ${orphans === 1 ? "names" : "name"} a post that is neither in this document nor on the Site; ${orphans === 1 ? "it" : "they"} will be skipped.`);
  if (outside) {
    lines.push(
      `${outside === 1 ? "1 reply names" : `${outside} replies name`} a parent comment that is not in this document; it must already be on the Site from an earlier import, or ${outside === 1 ? "the reply is" : "they are"} skipped.`,
    );
  }
  if (c.problems.length) lines.push(`Comments with problems, skipped (${c.problems.length}):`, ...listed(c.problems.map((x) => `- ${x}`), 20));
  return lines;
}

/** The comments section's lines for an apply reply. */
function commentsReport(ctx: Loaded): string[] {
  const c = ctx.comments;
  const p = ctx.progress.comments;
  if (c.rows.length === 0 && c.problems.length === 0) return [];
  const lines = [""];
  const skippedCount = c.problems.length + (p?.problem_count ?? 0);
  if (c.rows.length === 0) {
    lines.push("Reader comments: none to send.");
  } else if (p?.done && p.hash === commentsHash(c)) {
    lines.push(`Reader comments: delivered. Created ${p.written.created}, updated ${p.written.updated}, skipped ${skippedCount}.`);
  } else if (p?.error) {
    lines.push(
      p.error.startsWith(COMMENTS_SCOPE_MISSING)
        ? `Reader comments: NOT imported, because ${p.error}.`
        : `Reader comments: NOT imported, because ${p.error}. The articles are not affected; run the import again later to send them.`,
    );
  } else {
    lines.push(`Reader comments: ${p?.sent ?? 0} of ${c.rows.length} sent so far (created ${p?.written.created ?? 0}, updated ${p?.written.updated ?? 0}).`);
  }
  const skipped = [...c.problems, ...(p?.problems ?? [])];
  if (skipped.length) {
    const unlisted = (p?.problem_count ?? 0) - (p?.problems.length ?? 0);
    lines.push(`Comments skipped (${skippedCount}):`, ...listed(skipped.map((x) => `- ${x}`), 20), ...(unlisted > 0 ? [`- and ${unlisted} more the Site skipped`] : []));
    if (p?.done && p.problem_count) lines.push("To send the comments again once that is fixed (a missing article imported, say), run the import again with retry_failed: true.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// SEO data (the document's optional seo section, POST /seo/import, 0143)
// ---------------------------------------------------------------------------
/** Rows per call to POST /seo/import: within the API's caps (100 / 2,000 / 10,000), with room
 *  under its 4 MB body limit for long URLs. */
const SEO_CHUNK = { competitors: 100, keywords: 1_000, positions: 5_000 } as const;
/** The API's own caps: a dry run sends every keyword with each positions chunk up to these. */
const SEO_API_CAP = { competitors: 100, keywords: 2_000, positions: 10_000 } as const;
const SEO_SECTIONS = ["competitors", "keywords", "positions"] as const;

type SeoWritten = { keywords_created: number; keywords_updated: number; competitors_created: number; competitors_updated: number; positions: number };
interface SeoImportReply {
  written?: Partial<SeoWritten>;
  plan?: { keywords_new?: number; keywords_existing?: number; competitors_new?: number; competitors_existing?: number; positions?: number };
  tracked_keywords?: { limit: number | null; active: number };
  problems?: { section: string; index: number; error: string }[];
}

/**
 * v1: competitors, then keywords, then positions, because a position may name a keyword the same
 * section adds. A changed section (or a new version here) is sent again from the start, which is
 * harmless: keywords and competitors match what is there, positions SET.
 */
function seoHash(s: SeoCheck): string {
  return sha256(JSON.stringify({ v: 1, c: s.competitors, k: s.keywords, p: s.positions }));
}

/** The section has rows that have not all been delivered, as the document now has them. */
function seoPending(ctx: Loaded): boolean {
  const s = ctx.seo;
  if (s.keywords.length + s.competitors.length + s.positions.length === 0) return false;
  const p = ctx.progress.seo;
  return !(p && p.hash === seoHash(s) && p.done);
}

/** Where a missing permission is added: the same connection, no new sign-in (Blogify, 2026-09-29). */
const ADD_ON_CONNECTION =
  'add it to this connection in Settings > AI agents (https://app.writavo.com/settings/agents): Permissions on the connection, or "Migrate a blog". No reconnect is needed, and the next run carries on from here';
const seoScopeMissing = () =>
  `this connection lacks seo:write (${SCOPE_SCREEN["seo:write"] ?? "SEO, Read and write"}); ${ADD_ON_CONNECTION}`;

/**
 * Send what is left of the section, a chunk per request. Keywords and competitors already on the
 * Site are matched, positions SET their keyword and day, so a chunk sent twice changes nothing. A
 * reason to stop (time, requests, a busy API), or null when this call finished (delivered, or
 * refused for a reason recorded in progress.seo.error, which the next apply retries). A missing
 * seo:write is recorded, not fatal: the articles do not need it.
 */
async function sendSeo(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const s = ctx.seo;
  const hash = seoHash(s);
  if (!ctx.progress.seo || ctx.progress.seo.hash !== hash) {
    ctx.progress.seo = {
      hash,
      started: new Date().toISOString(),
      competitors_sent: 0,
      keywords_sent: 0,
      positions_sent: 0,
      done: false,
      written: { keywords_created: 0, keywords_updated: 0, competitors_created: 0, competitors_updated: 0, positions: 0 },
      problems: [],
    };
  }
  const p = ctx.progress.seo;
  delete p.error;
  for (const section of SEO_SECTIONS) {
    const rows: unknown[] = s[section];
    const sentKey = `${section}_sent` as const;
    while (p[sentKey] < rows.length) {
      if (Date.now() > state.deadline) return "the time for this call ran out while sending the SEO data";
      const max = state.opts.budget?.maxRequests;
      if (max !== undefined && requestsUsed(state) + 1 > max) return REQUEST_BUDGET_SPENT;
      const chunk = rows.slice(p[sentKey], p[sentKey] + SEO_CHUNK[section]);
      try {
        const res = await call<SeoImportReply>(
          ctx.api,
          {
            method: "POST",
            path: "/seo/import",
            body: { dry_run: false, [section]: chunk },
            // The delivery's start is in the key: a resumed chunk replays safely, while a section
            // sent again from the start (changed, or retry_failed) is new work, not a replay of the
            // first answer (which could hold a refusal the Site no longer makes).
            headers: { "Idempotency-Key": `import-seo-${sha256(`${p.started}|${hash}|${section}|${JSON.stringify(chunk)}`)}` },
          },
          state.hardDeadline,
        );
        const w = res.data?.written ?? {};
        p.written.keywords_created += w.keywords_created ?? 0;
        p.written.keywords_updated += w.keywords_updated ?? 0;
        p.written.competitors_created += w.competitors_created ?? 0;
        p.written.competitors_updated += w.competitors_updated ?? 0;
        p.written.positions += w.positions ?? 0;
        for (const prob of res.data?.problems ?? []) {
          if (p.problems.length < 40) p.problems.push(`seo.${prob.section}[${p[sentKey] + prob.index}]: ${prob.error}`);
        }
        p[sentKey] += chunk.length;
        await save(state, true);
      } catch (err) {
        if (isFatal(err) && err.code !== "INSUFFICIENT_SCOPE") throw err;
        if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while sending the SEO data`;
        p.error =
          err instanceof WritavoApiError && err.code === "INSUFFICIENT_SCOPE"
            ? seoScopeMissing()
            : err instanceof WritavoApiError && err.status === 404
              ? "this Site's API does not accept SEO data yet"
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
 * The Site's own answer to the section, through POST /seo/import with dry_run (which writes
 * nothing): the plan's keyword limit, what already exists, and the rows it would skip. Every
 * keyword goes with each chunk of positions, so a position naming a keyword the document adds is
 * judged as the apply will judge it. Null when there is nothing to ask; a string when it could
 * not be asked.
 */
async function seoSiteCheck(ctx: Loaded): Promise<SeoImportReply | string | null> {
  const s = ctx.seo;
  if (s.keywords.length + s.competitors.length + s.positions.length === 0) return null;
  const keywords = s.keywords.slice(0, SEO_API_CAP.keywords);
  const competitors = s.competitors.slice(0, SEO_API_CAP.competitors);
  const out: SeoImportReply = { plan: {}, problems: [] };
  const chunks = Math.max(1, Math.ceil(s.positions.length / SEO_API_CAP.positions));
  try {
    for (let i = 0; i < chunks; i += 1) {
      const positions = s.positions.slice(i * SEO_API_CAP.positions, (i + 1) * SEO_API_CAP.positions);
      const body = { dry_run: true, ...(i === 0 ? { keywords, competitors } : { keywords }), positions };
      const res = await call<SeoImportReply>(ctx.api, {
        method: "POST",
        path: "/seo/import",
        body,
        // A dry run is asked afresh every time: a replayed answer could predate a new keyword limit.
        headers: { "Idempotency-Key": `import-seo-dry-${sha256(`${Date.now()}:${JSON.stringify(body)}`)}` },
      });
      const d = res.data ?? {};
      if (i === 0) {
        out.plan = { ...d.plan };
        out.tracked_keywords = d.tracked_keywords;
      } else {
        out.plan!.positions = (out.plan!.positions ?? 0) + (d.plan?.positions ?? 0);
      }
      for (const prob of d.problems ?? []) {
        if (prob.section === "positions") out.problems!.push({ ...prob, index: i * SEO_API_CAP.positions + prob.index });
        else if (i === 0) out.problems!.push(prob);
      }
    }
  } catch (err) {
    return err instanceof WritavoApiError && err.code === "INSUFFICIENT_SCOPE" ? seoScopeMissing() : apiProblem(err);
  }
  return out;
}

/** The dry run's view of the SEO section: what it carries, and what the Site says it would do. */
async function seoDryRun(ctx: Loaded): Promise<string[]> {
  const s = ctx.seo;
  if (s.keywords.length + s.competitors.length + s.positions.length + s.problems.length === 0) return [];
  const withHistory = new Set(s.positions.map((r) => seoKeywordKey(r.keyword))).size;
  const lines = [
    "",
    `SEO data: ${plural(s.keywords.length, "keyword")}, ${plural(s.competitors.length, "competitor")} and ${s.positions.length} days of ranking history for ${plural(withHistory, "keyword")}. Sent after every article (competitors, then keywords, then positions): keywords and competitors already on the Site are updated, never duplicated, and each position SETS its keyword and day, so re-running never duplicates. Free: no rank check runs and nothing is charged.`,
  ];
  if (s.problems.length) lines.push(`SEO rows with problems, skipped (${s.problems.length}):`, ...listed(s.problems.map((x) => `- ${x}`), 20));
  if (!seoPending(ctx)) {
    lines.push("SEO data: already delivered by an earlier run.");
    return lines;
  }
  const site = await seoSiteCheck(ctx);
  if (typeof site === "string") {
    lines.push(`The Site could not check the SEO rows (${site}), so the keyword limit and the rows it would skip were not checked.`);
    return lines;
  }
  if (!site) return lines;
  const plan = site.plan ?? {};
  const tk = site.tracked_keywords;
  lines.push(
    `On the Site: ${plural(plan.keywords_new ?? 0, "new keyword")} and ${plan.keywords_existing ?? 0} already tracked; ${plural(plan.competitors_new ?? 0, "new competitor")} and ${plan.competitors_existing ?? 0} already there; ${plan.positions ?? 0} days of history accepted.`,
  );
  if (tk && tk.limit !== null && tk.limit !== undefined) {
    const over = (site.problems ?? []).filter((x) => x.section === "keywords" && x.error.startsWith("over the tracked-keyword limit")).length;
    lines.push(
      over
        ? `Keyword limit: the plan tracks up to ${tk.limit} keywords across the organisation and ${tk.active} are tracked now, so ${over} of the new keywords will NOT be added (listed below), nor their ranking history. Raise the limit, or pause keywords, before importing, or remove those keywords from the document.`
        : `Keyword limit: the plan tracks up to ${tk.limit} keywords across the organisation and ${tk.active} are tracked now; the new keywords fit.`,
    );
  }
  if (s.keywords.length > SEO_API_CAP.keywords) {
    lines.push(`Only the first ${SEO_API_CAP.keywords} keywords were checked with the Site (the most one request takes); the rest are sent in later requests and checked then.`);
  }
  const skipped = (site.problems ?? []).map((x) => `- seo.${x.section}[${x.index}]: ${x.error}`);
  if (skipped.length) lines.push(`SEO rows the Site would skip (${skipped.length}):`, ...listed(skipped, 20));
  return lines;
}

/** The SEO section's lines for an apply reply. */
function seoReport(ctx: Loaded): string[] {
  const s = ctx.seo;
  const p = ctx.progress.seo;
  if (s.keywords.length + s.competitors.length + s.positions.length + s.problems.length === 0) return [];
  const lines = [""];
  if (p?.done && p.hash === seoHash(s)) {
    const w = p.written;
    lines.push(
      `SEO data: delivered. Keywords tracked ${w.keywords_created}, updated ${w.keywords_updated}; competitors added ${w.competitors_created}, updated ${w.competitors_updated}; days of ranking history set ${w.positions}.`,
    );
  } else if (p?.error) {
    lines.push(`SEO data: NOT imported, because ${p.error}. The articles are not affected; run the import again later to send it.`);
  } else {
    lines.push(
      `SEO data: ${p?.competitors_sent ?? 0} of ${s.competitors.length} competitors, ${p?.keywords_sent ?? 0} of ${s.keywords.length} keywords and ${p?.positions_sent ?? 0} of ${s.positions.length} days of ranking history sent so far.`,
    );
  }
  const skipped = [...s.problems, ...(p?.problems ?? [])];
  if (skipped.length) {
    lines.push(`SEO rows skipped (${skipped.length}):`, ...listed(skipped.map((x) => `- ${x}`), 20));
    if (p?.done && p.problems.length) lines.push("To send the section again once that is fixed (a higher keyword limit, say), run the import again with retry_failed: true.");
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Redirects: every article's old_urls plus the document's redirects section (0127)
// ---------------------------------------------------------------------------
/** Rows per call to POST /redirects/bulk (the API takes 5,000; 500 keeps a body well under 4 MB). */
const REDIRECTS_CHUNK = 500;

interface RedirectRow {
  from: string;
  to?: string;
  to_external_id?: string;
  status?: 301 | 302;
  note?: string;
}

/**
 * The list to send, in document order: each valid article's old_urls (to that article, by
 * external_id), then the redirects section. An old URL named twice keeps its first target; the
 * later ones are listed as problems (the API would refuse the pair in one call, and across calls
 * the second would silently win).
 */
function redirectList(ctx: Loaded): { rows: RedirectRow[]; duplicates: string[] } {
  const rows: RedirectRow[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  // Case, a trailing slash and "www." do not make a different old URL (the API's normalisation).
  const key = (from: string) =>
    from.trim().toLowerCase().replace(/^(https?:\/\/)www\./, "$1").replace(/^https?:\/\//, "").replace(/\/+(\?|#|$)/, "$1");
  const add = (row: RedirectRow, label: string) => {
    const k = key(row.from);
    if (seen.has(k)) return void duplicates.push(`${label}: ${row.from} is already redirected earlier in the document; this one is skipped`);
    seen.add(k);
    rows.push(row);
  };
  for (const v of ctx.valid) {
    (v.article.old_urls ?? []).forEach((from, i) =>
      add({ from, to_external_id: v.article.external_id }, `${v.article.external_id} old_urls[${i}]`),
    );
  }
  ctx.redirects.rows.forEach((r, i) => add(r, `redirects[${i}]`));
  return { rows, duplicates };
}

function redirectsHash(rows: RedirectRow[]): string {
  return sha256(JSON.stringify(rows));
}

/** There are redirects that have not all been delivered, as the document now has them. */
function redirectsPending(ctx: Loaded): boolean {
  const { rows } = redirectList(ctx);
  if (rows.length === 0) return false;
  const p = ctx.progress.redirects;
  return !(p && p.hash === redirectsHash(rows) && p.done);
}

/**
 * Send what is left, a chunk per request. SET semantics on the old URL, so a chunk sent twice
 * changes nothing. A redirect to an article that failed to import comes back as a problem. A
 * reason to stop, or null when this call finished (delivered, or refused for a reason recorded in
 * progress.redirects.error, which the next apply retries).
 */
async function sendRedirects(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const { rows } = redirectList(ctx);
  const hash = redirectsHash(rows);
  if (!ctx.progress.redirects || ctx.progress.redirects.hash !== hash) {
    ctx.progress.redirects = { hash, sent: 0, done: false, written: { created: 0, updated: 0, unchanged: 0 }, problems: [] };
  }
  const p = ctx.progress.redirects;
  delete p.error;
  while (p.sent < rows.length) {
    if (Date.now() > state.deadline) return "the time for this call ran out while sending the redirects";
    const max = state.opts.budget?.maxRequests;
    if (max !== undefined && requestsUsed(state) + 1 > max) return REQUEST_BUDGET_SPENT;
    const chunk = rows.slice(p.sent, p.sent + REDIRECTS_CHUNK);
    try {
      const res = await call<{ written?: { created?: number; updated?: number; unchanged?: number }; problems?: { index: number; error: string }[] }>(
        ctx.api,
        {
          method: "POST",
          path: "/redirects/bulk",
          body: { dry_run: false, redirects: chunk },
          headers: { "Idempotency-Key": `import-redirects-${sha256(JSON.stringify(chunk))}` },
        },
        state.hardDeadline,
      );
      const w = res.data?.written ?? {};
      p.written.created += w.created ?? 0;
      p.written.updated += w.updated ?? 0;
      p.written.unchanged += w.unchanged ?? 0;
      for (const prob of res.data?.problems ?? []) {
        if (p.problems.length < 40) p.problems.push(`${chunk[prob.index]?.from ?? `row ${p.sent + prob.index}`}: ${prob.error}`);
      }
      p.sent += chunk.length;
      await save(state, true);
    } catch (err) {
      if (isFatal(err)) throw err;
      if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while sending the redirects`;
      p.error =
        err instanceof WritavoApiError && err.status === 404
          ? "this Site's API does not accept redirects yet"
          : apiProblem(err);
      await save(state, true);
      return null;
    }
  }
  p.done = true;
  await save(state, true);
  return null;
}

/** The dry run's view of the redirects. Nothing is sent: the articles may not exist yet. */
function redirectsDryRun(ctx: Loaded): string[] {
  const { rows, duplicates } = redirectList(ctx);
  const problems = [...ctx.redirects.problems, ...duplicates];
  if (rows.length === 0 && problems.length === 0) return [];
  const fromArticles = rows.filter((r) => r.to_external_id !== undefined && !r.to).length;
  const lines = [
    "",
    `Redirects: ${rows.length} old URLs (${fromArticles} from articles' old_urls, ${rows.length - fromArticles} from the redirects section). Sent after every article is imported. Each answers with a 301 on the blog once its target is published; an old URL on a domain the blog is not served on is kept for the customer's own server (GET /redirects/export).`,
  ];
  if (problems.length) lines.push(`Redirects with problems, skipped (${problems.length}):`, ...listed(problems.map((x) => `- ${x}`), 20));
  return lines;
}

/** The redirects' lines for an apply reply. */
function redirectsReport(ctx: Loaded): string[] {
  const { rows, duplicates } = redirectList(ctx);
  const p = ctx.progress.redirects;
  if (rows.length === 0 && ctx.redirects.problems.length === 0 && duplicates.length === 0) return [];
  const lines = [""];
  if (p?.done && p.hash === redirectsHash(rows)) {
    lines.push(`Redirects: delivered. Created ${p.written.created}, updated ${p.written.updated}, unchanged ${p.written.unchanged}.`);
  } else if (p?.error) {
    lines.push(`Redirects: NOT imported, because ${p.error}. The articles are not affected; run the import again later to send them.`);
  } else {
    lines.push(`Redirects: ${p?.sent ?? 0} of ${rows.length} sent so far.`);
  }
  const skipped = [...ctx.redirects.problems, ...duplicates, ...(p?.problems ?? [])];
  if (skipped.length) lines.push(`Redirects skipped (${skipped.length}):`, ...listed(skipped.map((x) => `- ${x}`), 20));
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

// ---------------------------------------------------------------------------
// Cost history of live articles left unchanged (publish false)
// ---------------------------------------------------------------------------
/** Items per call to POST /articles/cost-history (the API takes 100). */
const COST_BULK_CHUNK = 100;

function costHash(entries: CostEntry[]): string {
  return sha256(JSON.stringify(entries));
}

/**
 * Articles whose content was left alone because they are live and publish is false, and whose
 * cost history has not been written yet. The cost history never appears on the public blog, so it
 * is not part of the "do not touch live content" promise: it is sent for them on its own, after
 * the articles, so a migrated blog whose articles were already live can still get it.
 */
function costHistoryTargets(ctx: Loaded): ValidItem[] {
  return ctx.valid.filter((v) => {
    if (v.article.cost_history === undefined) return false;
    const item = ctx.progress.items[v.article.external_id];
    if (!item || item.hash !== v.hash || item.outcome !== "deferred") return false;
    const p = ctx.progress.cost_history?.[v.article.external_id];
    return !(p && p.done && p.hash === costHash(v.article.cost_history));
  });
}

interface BulkCostResult {
  results?: { index: number; status: string; error?: string; problems?: { index: number; error: string }[] }[];
}

/**
 * Send that cost history, up to 100 articles per request, named by external_id. SET semantics per
 * article, so a chunk sent twice changes nothing. A reason to stop (time, requests, a busy API),
 * or null when this call finished (delivered, or refused for a reason recorded in
 * progress.cost_history_error, which the next apply retries).
 */
async function sendLiveCostHistory(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const targets = costHistoryTargets(ctx);
  if (targets.length === 0) return null;
  ctx.progress.cost_history ??= {};
  delete ctx.progress.cost_history_error;
  for (let i = 0; i < targets.length; i += COST_BULK_CHUNK) {
    if (Date.now() > state.deadline) return "the time for this call ran out while sending cost history";
    const max = state.opts.budget?.maxRequests;
    if (max !== undefined && requestsUsed(state) + 1 > max) return REQUEST_BUDGET_SPENT;
    const chunk = targets.slice(i, i + COST_BULK_CHUNK);
    const items = chunk.map((v) => ({ external_id: v.article.external_id, entries: v.article.cost_history! }));
    try {
      const res = await call<BulkCostResult>(
        ctx.api,
        {
          method: "POST",
          path: "/articles/cost-history",
          body: { items },
          headers: { "Idempotency-Key": `import-costs-bulk-${sha256(JSON.stringify(items))}` },
        },
        state.hardDeadline,
      );
      for (const r of res.data?.results ?? []) {
        const v = chunk[r.index];
        if (!v) continue;
        const id = v.article.external_id;
        const label = itemLabel(v.check);
        const hash = costHash(v.article.cost_history!);
        if (r.status === "written") {
          ctx.progress.cost_history[id] = { hash, done: true };
          for (const prob of r.problems ?? []) state.warnings.push(`- ${label}: cost_history[${prob.index}] was not imported: ${prob.error}`);
        } else {
          ctx.progress.cost_history[id] = { hash, done: true, error: r.error ?? r.status };
          state.warnings.push(`- ${label}: its cost history was not imported: ${r.error ?? r.status}`);
        }
      }
      await save(state, true);
    } catch (err) {
      if (isFatal(err)) throw err;
      if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while sending cost history`;
      ctx.progress.cost_history_error =
        err instanceof WritavoApiError && err.status === 404
          ? "this Site's API does not accept bulk cost history yet"
          : apiProblem(err);
      await save(state, true);
      return null;
    }
  }
  return null;
}

/** Cost history of live articles for an apply reply. */
function costHistoryReport(ctx: Loaded): string[] {
  const all = ctx.valid.filter(
    (v) => v.article.cost_history !== undefined && ctx.progress.items[v.article.external_id]?.hash === v.hash && ctx.progress.items[v.article.external_id]?.outcome === "deferred",
  );
  if (all.length === 0) return [];
  const written = all.filter((v) => {
    const p = ctx.progress.cost_history?.[v.article.external_id];
    return p?.done && !p.error && p.hash === costHash(v.article.cost_history!);
  }).length;
  const refused = all.filter((v) => ctx.progress.cost_history?.[v.article.external_id]?.error).length;
  const err = ctx.progress.cost_history_error;
  return [
    "",
    err
      ? `Cost history of live articles: NOT imported, because ${err}. The articles are not affected; run the import again later to send it.`
      : `Cost history of live articles (their content was left as it is): written for ${written} of ${all.length}${refused ? `, ${refused} refused (listed above)` : ""}.`,
  ];
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

  const entriesToPublish = entriesPending(ctx)
    ? ctx.entries.rows.filter((e) => entryLifecycle(e, opts) !== "none" && ctx.progress.entries?.[e.external_id]?.stage !== "done").length
    : 0;
  const toPublish = pending.filter((v) => lifecycleOf(v.article, opts) === "publish").length + entriesToPublish;
  const toSchedule = pending.filter((v) => lifecycleOf(v.article, opts) === "schedule").length;
  if (opts.publish && toPublish + toSchedule > 0 && !opts.confirm) {
    return tagged("needs_confirm", text(
      [
        "Nothing has been done. This import needs the user to confirm first.",
        "",
        `It publishes ${plural(toPublish, "article")} on the Site "${ctx.site.name}" with their original dates, where search engines and readers will see them${toSchedule ? `, schedules ${plural(toSchedule, "article")} to go live at their scheduled times` : ""}, and updates to articles already live take effect immediately.${pending.length > toPublish + toSchedule ? ` Drafts imported as drafts: ${pending.length - toPublish - toSchedule}.` : ""}`,
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
    counts: { created: 0, updated: 0, unchanged: 0, published: 0, scheduled: 0, deferred: 0, skipped: 0, failed: 0, imagesCopied: 0, imagesFailed: 0 },
    problems: [],
    warnings: [],
    lastSave: Date.now(),
    saving: Promise.resolve(),
    extraRequests: 0,
  };

  let stopped: string | null = null;
  if (contentTypesPending(ctx)) {
    try {
      stopped = await applyContentTypes(state);
    } catch (err) {
      await save(state, true);
      if (isFatal(err)) return tagged("stopped", stopReport(state, err));
      stopped = err instanceof OutOfRequests ? REQUEST_BUDGET_SPENT : `the content types could not be applied (${apiProblem(err)})`;
    }
  }
  // The AI writing profile is one PATCH and depends on nothing else, so it goes first: a long import
  // fills the profile on its first call. A refusal is recorded and tried once more at the end.
  if (!stopped && profilePending(ctx) && !profileRefused(ctx)) {
    try {
      stopped = await sendProfile(state);
    } catch (err) {
      await save(state, true);
      if (err instanceof OutOfRequests) stopped = REQUEST_BUDGET_SPENT;
      else return tagged("stopped", stopReport(state, err));
    }
  }
  const termsStarted = Date.now();
  try {
    if (stopped) {
      // nothing more this call
    } else if (!(await ensureTaxonomy(state))) stopped = "this call's time or request budget ran out while creating categories, tags and authors";
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
  // Entries go after every article (they may reference articles), then the articles' custom
  // fields (which may reference entries). Both resumable; see sendEntries.
  for (const [pending_, send] of [[entriesPending, sendEntries], [customFieldsPending, sendCustomFields]] as const) {
    if (remaining === 0 && !stopped && pending_(ctx)) {
      try {
        const why = await send(state);
        if (why) stopped = why;
      } catch (err) {
        await save(state, true);
        if (err instanceof OutOfRequests) stopped = REQUEST_BUDGET_SPENT;
        else if (isFatal(err)) return tagged("stopped", stopReport(state, err));
        else throw err;
      }
    }
  }
  // Redirects go after every article (they point at the articles by external_id), then the
  // engagement history (keyed by the posts), both in chunks and both SET, never add.
  if (remaining === 0 && !stopped && costHistoryTargets(ctx).length > 0) {
    try {
      const why = await sendLiveCostHistory(state);
      if (why) stopped = why;
    } catch (err) {
      await save(state, true);
      if (err instanceof OutOfRequests) stopped = REQUEST_BUDGET_SPENT;
      else if (isFatal(err)) return tagged("stopped", stopReport(state, err));
      else throw err;
    }
  }
  if (remaining === 0 && !stopped && redirectsPending(ctx)) {
    const why = await sendRedirects(state);
    if (why) stopped = why;
  }
  if (remaining === 0 && !stopped && engagementPending(ctx)) {
    const why = await sendEngagement(state);
    if (why) stopped = why;
  }
  // Reader comments after the engagement (they need their articles to exist), parents first. A
  // missing comments:write is recorded and reported, never a reason to stop the import.
  // retry_failed sends a delivered section again when the Site skipped rows.
  if (remaining === 0 && !stopped && opts.retryFailed && ctx.progress.comments?.done && ctx.progress.comments.problem_count > 0) {
    delete ctx.progress.comments;
  }
  if (remaining === 0 && !stopped && commentsPending(ctx)) {
    try {
      const why = await sendComments(state);
      if (why) stopped = why;
    } catch (err) {
      await save(state, true);
      if (err instanceof OutOfRequests) stopped = REQUEST_BUDGET_SPENT;
      else if (isFatal(err)) return tagged("stopped", stopReport(state, err));
      else throw err;
    }
  }
  // The SEO data last (keyed on keywords and domains, not on the posts). retry_failed sends a
  // delivered section again when the Site skipped rows, e.g. after the plan's keyword limit rose.
  if (remaining === 0 && !stopped && opts.retryFailed && ctx.progress.seo?.done && ctx.progress.seo.problems.length > 0) {
    delete ctx.progress.seo;
  }
  if (remaining === 0 && !stopped && seoPending(ctx)) {
    try {
      const why = await sendSeo(state);
      if (why) stopped = why;
    } catch (err) {
      await save(state, true);
      if (err instanceof OutOfRequests) stopped = REQUEST_BUDGET_SPENT;
      else if (isFatal(err)) return tagged("stopped", stopReport(state, err));
      else throw err;
    }
  }
  // The profile's one retry, once every article is in (it was refused at the start of a call).
  if (remaining === 0 && !stopped && profileRefused(ctx)) {
    try {
      const why = await sendProfile(state);
      if (why) stopped = why;
    } catch (err) {
      await save(state, true);
      if (err instanceof OutOfRequests) stopped = REQUEST_BUDGET_SPENT;
      else return tagged("stopped", stopReport(state, err));
    }
  }
  const costUnfinished = costHistoryTargets(ctx).length > 0 && !ctx.progress.cost_history_error;
  const redirectsUnfinished = redirectsPending(ctx) && !ctx.progress.redirects?.error;
  const engagementUnfinished = engagementPending(ctx) && !ctx.progress.engagement?.error;
  const commentsUnfinished = commentsPending(ctx) && !ctx.progress.comments?.error;
  const seoUnfinished = seoPending(ctx) && !ctx.progress.seo?.error;
  const sectionsUnfinished =
    (contentTypesPending(ctx) && !ctx.progress.content_types?.error) || entriesPending(ctx) || customFieldsPending(ctx);
  const profileUnfinished = profilePending(ctx) && !profileRefused(ctx);
  const allDone = remaining === 0 && !engagementUnfinished && !commentsUnfinished && !seoUnfinished && !redirectsUnfinished && !costUnfinished && !sectionsUnfinished && !profileUnfinished;
  const c = state.counts;
  const lines: string[] = [];
  const thisCall = `This call: created ${c.created}, updated ${c.updated}, published ${c.published}${c.scheduled ? `, scheduled ${c.scheduled}` : ""}${c.unchanged ? `, already up to date ${c.unchanged}` : ""}, left unchanged ${c.deferred}, skipped ${c.skipped}, failed ${c.failed}. Images copied ${c.imagesCopied}${c.imagesFailed ? `, not copied ${c.imagesFailed}` : ""}.`;
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
    lines.push(...contentTypesReport(ctx), ...entriesReport(ctx), ...customFieldsReport(ctx));
    lines.push(...costHistoryReport(ctx));
    lines.push(...redirectsReport(ctx));
    lines.push(...engagementReport(ctx));
    lines.push(...commentsReport(ctx));
    lines.push(...seoReport(ctx));
    lines.push(...(await profileReport(ctx, true)));
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
        ? sectionsUnfinished
          ? `Every article is imported into the Site "${ctx.site.name}"; the content types, entries or custom fields are still being written.`
          : `Every article is imported into the Site "${ctx.site.name}"; ${[costUnfinished && "the cost history", redirectsUnfinished && "the redirects", engagementUnfinished && "the engagement history", commentsUnfinished && "the reader comments", seoUnfinished && "the SEO data"].filter(Boolean).join(" and ")} ${[costUnfinished, redirectsUnfinished, engagementUnfinished, seoUnfinished].filter(Boolean).length + (commentsUnfinished ? 2 : 0) > 1 ? "are" : "is"} still being sent.`
        : `Imported a batch into the Site "${ctx.site.name}". ${ctx.valid.length - remaining} of ${ctx.valid.length} articles are done and ${remaining} remain.`,
      "",
      thisCall,
      `Categories created so far ${created.categories}, tags ${created.tags}, authors ${created.authors}.`,
    );
    if (stopped) lines.push(`Stopped early: ${stopped}.`);
    if (state.problems.length > 0) lines.push("", "Problems this call:", ...listed(state.problems));
    if (state.warnings.length > 0) lines.push("", "Warnings this call:", ...listed(state.warnings));
    lines.push(...contentTypesReport(ctx), ...entriesReport(ctx), ...customFieldsReport(ctx));
    lines.push(...costHistoryReport(ctx));
    lines.push(...redirectsReport(ctx));
    lines.push(...engagementReport(ctx));
    lines.push(...commentsReport(ctx));
    lines.push(...seoReport(ctx));
    lines.push(...(await profileReport(ctx, false)));
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
  /** Section work the counters above do not show (0136): content types, entries, custom fields,
   *  redirects and engagement sent. The job runner counts it as progress. */
  work_units: number;
  /** What the sections after the articles delivered, for status replies (absent: nothing to say). */
  engagement?: { daily: number; share_rows: number; picks: number; done: boolean; error: string | null };
  comments?: { created: number; updated: number; problems: number; done: boolean; error: string | null };
  seo?: { keywords_created: number; keywords_updated: number; competitors_created: number; competitors_updated: number; positions: number; done: boolean; error: string | null };
  cost_history?: { written: number; refused: number; error: string | null };
  redirects?: { created: number; updated: number; unchanged: number; done: boolean; error: string | null };
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
    work_units: sectionWorkUnits(progress),
    ...(progress?.engagement
      ? { engagement: { ...progress.engagement.written, done: progress.engagement.done, error: progress.engagement.error ?? null } }
      : {}),
    ...(progress?.comments
      ? { comments: { ...progress.comments.written, problems: progress.comments.problem_count, done: progress.comments.done, error: progress.comments.error ?? null } }
      : {}),
    ...(progress?.seo ? { seo: { ...progress.seo.written, done: progress.seo.done, error: progress.seo.error ?? null } } : {}),
    ...(progress?.cost_history || progress?.cost_history_error
      ? {
          cost_history: {
            written: Object.values(progress.cost_history ?? {}).filter((c) => c.done && !c.error).length,
            refused: Object.values(progress.cost_history ?? {}).filter((c) => c.error).length,
            error: progress.cost_history_error ?? null,
          },
        }
      : {}),
    ...(progress?.redirects
      ? { redirects: { ...progress.redirects.written, done: progress.redirects.done, error: progress.redirects.error ?? null } }
      : {}),
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

// ---------------------------------------------------------------------------
// Content types, entries and articles' custom fields (API 1.5.0, 0136)
// ---------------------------------------------------------------------------
// ORDER. The content types go first (before the taxonomy): entries and custom fields need them.
// Entries go after every article, in two passes: WRITE (create a draft without its references,
// or find the existing one by external_id) and RESOLVE (every entry and article of the document
// now exists, so each portable $ref / $media becomes an id; then the entry's status is set).
// Articles' custom_fields go last, once the entries they may reference exist. A reference to
// something that is in neither this document nor the Site (a later volume of an export) is left
// out with a warning; running the import again after the rest arrives fills it in.

const ENTRY_WRITE_VERSION = "e1";

function contentTypesHash(ctx: Loaded): string {
  return sha256(JSON.stringify(ctx.contentTypes.types));
}

function contentTypesPending(ctx: Loaded): boolean {
  if (ctx.contentTypes.types.length === 0) return false;
  const p = ctx.progress.content_types;
  return !(p && p.hash === contentTypesHash(ctx) && p.done);
}

interface SchemaPlan {
  create?: string[];
  update?: Array<{ api_id: string; added?: string[]; removed?: string[]; renamed?: Array<{ from: string; to: string }>; retyped?: string[]; entries?: number }>;
  delete?: string[];
  unchanged?: string[];
}
interface SchemaApply {
  ok: boolean;
  plan?: SchemaPlan;
  errors?: Array<{ path: string; code: string; message: string }>;
}

function planLine(plan: SchemaPlan | undefined): string {
  if (!plan) return "no plan";
  const parts: string[] = [];
  if (plan.create?.length) parts.push(`create ${plan.create.join(", ")}`);
  if (plan.update?.length) {
    parts.push(`change ${plan.update.map((u) => {
      const bits = [
        u.added?.length ? `+${u.added.join(", +")}` : "",
        u.removed?.length ? `-${u.removed.join(", -")} (values kept, no longer shown)` : "",
        u.renamed?.length ? u.renamed.map((r) => `${r.from}->${r.to}`).join(", ") : "",
        u.retyped?.length ? `retyped ${u.retyped.join(", ")}` : "",
      ].filter(Boolean);
      return `${u.api_id}${bits.length ? ` (${bits.join("; ")})` : ""}`;
    }).join("; ")}`);
  }
  if (plan.unchanged?.length) parts.push(`unchanged ${plan.unchanged.length}`);
  return parts.join(". ") || "nothing to change";
}

/** Apply the document's content types (never deleting the Site's others). Null, or why to stop. */
async function applyContentTypes(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const hash = contentTypesHash(ctx);
  ctx.progress.content_types = { hash, done: false };
  const p = ctx.progress.content_types;
  need(state, 1);
  try {
    const res = await call<SchemaApply>(
      ctx.api,
      { method: "POST", path: "/content-types/apply", body: { types: ctx.contentTypes.types, dry_run: false, delete_missing: false } },
      state.hardDeadline,
    );
    p.done = true;
    p.plan = planLine(res.data?.plan);
  } catch (err) {
    if (isFatal(err)) throw err;
    if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while applying the content types`;
    p.error = err instanceof WritavoApiError && err.status === 404 ? "this Site's API has no content types yet" : apiProblem(err);
  }
  await save(state, true);
  return null;
}

async function contentTypesDryRun(ctx: Loaded): Promise<string[]> {
  const t = ctx.contentTypes;
  if (t.types.length === 0 && t.problems.length === 0) return [];
  const lines = ["", `Content types: ${t.types.length} in the file, applied before everything else (types on the Site that the file does not name are left alone).`];
  if (t.types.length) {
    try {
      const res = await call<SchemaApply>(ctx.api, { method: "POST", path: "/content-types/apply", body: { types: t.types, dry_run: true } });
      lines.push(`- plan: ${planLine(res.data?.plan)}.`);
      const errs = res.data?.errors ?? [];
      if (errs.length) lines.push(`The Site refuses these content types as written (${errs.length}); nothing is applied until they are fixed:`, ...listed(errs.map((e) => `- ${e.path}: ${e.message}`), 20));
    } catch (err) {
      lines.push(`- the Site could not check them: ${apiProblem(err)}.`);
    }
  }
  if (t.problems.length) lines.push(`Content types with problems, skipped (${t.problems.length}):`, ...listed(t.problems.map((x) => `- ${x}`), 20));
  return lines;
}

function contentTypesReport(ctx: Loaded): string[] {
  const p = ctx.progress.content_types;
  if (ctx.contentTypes.types.length === 0) return [];
  if (p?.done) return ["", `Content types: applied (${p.plan ?? "done"}).`];
  if (p?.error) return ["", `Content types: NOT applied, because ${p.error}. Entries of types the Site does not have fail until this is fixed; run the import again afterwards.`];
  return ["", "Content types: not applied yet."];
}

// ---- portable values -------------------------------------------------------
function isPortableRef(v: unknown): v is { $ref: { type: string; external_id?: string; slug?: string } } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const r = (v as { $ref?: unknown }).$ref;
  return keys.length === 1 && keys[0] === "$ref" && !!r && typeof r === "object" && typeof (r as { type?: unknown }).type === "string";
}

function isPortableMedia(v: unknown): v is { $media: { url: string; alt?: string } } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  const m = (v as { $media?: unknown }).$media;
  return keys.length === 1 && keys[0] === "$media" && !!m && typeof m === "object" && typeof (m as { url?: unknown }).url === "string";
}

/** The value tree with every portable value taken out (the write pass: an entry exists first). */
function withoutPortable(v: unknown): unknown {
  if (isPortableRef(v) || isPortableMedia(v)) return undefined;
  if (Array.isArray(v)) return v.map(withoutPortable).filter((x) => x !== undefined);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = withoutPortable(x);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return v;
}

function hasPortable(v: unknown): boolean {
  if (isPortableRef(v) || isPortableMedia(v)) return true;
  if (Array.isArray(v)) return v.some(hasPortable);
  if (v && typeof v === "object") return Object.values(v).some(hasPortable);
  return false;
}

interface Resolver {
  cache: Map<string, string | null>;
}

/** One reference as an id on the target Site, or null when it is not there (yet). */
async function resolveRef(state: ApplyState, r: Resolver, ref: { type: string; external_id?: string; slug?: string }): Promise<string | null> {
  const { ctx } = state;
  const key = `${ref.type}:${ref.external_id ?? ""}:${ref.slug ?? ""}`;
  if (r.cache.has(key)) return r.cache.get(key)!;
  let id: string | null = null;
  if (ref.type === "category" || ref.type === "tag") {
    if (ref.slug) id = (ref.type === "category" ? ctx.progress.categories[ref.slug] ?? ctx.siteCategories.get(ref.slug) : ctx.progress.tags[ref.slug] ?? ctx.siteTags.get(ref.slug)) ?? null;
  } else if (ref.type === "author") {
    if (ref.slug) id = ctx.progress.authors[ref.slug] ?? ctx.siteAuthors.bySlug.get(ref.slug)?.id ?? null;
  } else if (ref.type === "article" || ref.type === "page") {
    if (ref.external_id) {
      id = ctx.progress.items[ref.external_id]?.article_id ?? null;
      if (!id) {
        need(state, 1);
        id = (await findByExternalId(ctx.api, ref.external_id, state.hardDeadline))?.id ?? null;
      }
    }
  } else if (ref.external_id) {
    id = ctx.progress.entries?.[ref.external_id]?.id ?? null;
    if (!id) {
      need(state, 1);
      try {
        id = (await findEntryByExternalId(ctx.api, ref.type, ref.external_id, state.hardDeadline))?.id ?? null;
      } catch (err) {
        if (!(err instanceof WritavoApiError && err.status === 404)) throw err;
      }
    }
  }
  r.cache.set(key, id);
  return id;
}

/** The value tree with every portable value turned into an id; one that cannot be is left out. */
async function resolvePortable(state: ApplyState, r: Resolver, v: unknown, where: string, warnings: string[]): Promise<unknown> {
  if (isPortableRef(v)) {
    const id = await resolveRef(state, r, v.$ref);
    if (!id) warnings.push(`${where}: ${v.$ref.type} ${v.$ref.external_id ?? v.$ref.slug} is not in this document or on the Site, so the reference is left out (import again once it is there)`);
    return id ?? undefined;
  }
  if (isPortableMedia(v)) {
    if (!state.opts.rehostImages) {
      warnings.push(`${where}: media ${v.$media.url} is left out, because rehost_images is false and a media field needs a copy in the library`);
      return undefined;
    }
    const asset = await rehostAsset(state, v.$media.url, v.$media.alt, "blog-images", warnings, true);
    if (!asset?.id) warnings.push(`${where}: media ${v.$media.url} could not be copied into the library, so it is left out`);
    return asset?.id;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (let i = 0; i < v.length; i += 1) {
      const x = await resolvePortable(state, r, v[i], `${where}[${i}]`, warnings);
      if (x !== undefined) out.push(x);
    }
    return out;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const y = await resolvePortable(state, r, x, `${where}.${k}`, warnings);
      if (y !== undefined) out[k] = y;
    }
    return out;
  }
  return v;
}

// ---- entries ---------------------------------------------------------------
function entryHash(e: ImportEntry): string {
  return sha256(`${ENTRY_WRITE_VERSION}:${JSON.stringify(e)}`);
}

function entriesPending(ctx: Loaded): boolean {
  return ctx.entries.rows.some((e) => {
    const p = ctx.progress.entries?.[e.external_id];
    return !p || p.hash !== entryHash(e) || (p.stage !== "done" && p.outcome !== "failed" && p.outcome !== "skipped");
  });
}

function entryLifecycle(e: ImportEntry, opts: ImportOptions): "publish" | "schedule" | "none" {
  if (!opts.publish) return "none";
  if (e.status === "published") return "publish";
  if (e.status === "scheduled" && e.scheduled_at && Date.parse(e.scheduled_at) > Date.now()) return "schedule";
  return "none";
}

/**
 * The entries, in two passes, each resumable. A reason to stop (time, requests, a busy API), or
 * null when every entry has been dealt with (done, deferred, or failed with a recorded reason).
 */
async function sendEntries(state: ApplyState): Promise<string | null> {
  const { ctx, opts } = state;
  ctx.progress.entries ??= {};
  const progress = ctx.progress.entries;
  const now = () => new Date().toISOString();
  const budgetLeft = (n: number) => {
    const max = opts.budget?.maxRequests;
    return max === undefined || requestsUsed(state) + n <= max;
  };

  // Pass 1: every entry exists (a new one as a draft, without its references).
  for (const e of ctx.entries.rows) {
    const hash = entryHash(e);
    const p = progress[e.external_id];
    if (p && p.hash === hash && (p.id || p.outcome === "failed" || p.outcome === "skipped")) continue;
    if (Date.now() > state.deadline) return "the time for this call ran out while writing the entries";
    if (!budgetLeft(3)) return REQUEST_BUDGET_SPENT;
    const label = `entry ${e.external_id} (${e.type})`;
    try {
      need(state, 1);
      const existing = await findEntryByExternalId(ctx.api, e.type, e.external_id, state.hardDeadline);
      if (existing) {
        if (existing.status !== "draft" && !state.mayTouchLive) {
          progress[e.external_id] = { hash, id: existing.id, action: "updated", stage: "done", outcome: "deferred", error: "it is live and this import may not change live content (publish is false or not confirmed)", updated_at: now() };
          state.counts.deferred += 1;
        } else {
          progress[e.external_id] = { hash, id: existing.id, action: "updated", stage: "written", outcome: "retry", updated_at: now() };
        }
      } else {
        need(state, 1);
        const body = { external_id: e.external_id, ...(e.slug ? { slug: e.slug } : {}), data: withoutPortable(e.data) };
        const res = await call<{ id: string }>(
          ctx.api,
          { method: "POST", path: `/entries/${encodeURIComponent(e.type)}`, body, headers: { "Idempotency-Key": `import-entry-${sha256(`${e.external_id}\n${JSON.stringify(body)}`)}` } },
          state.hardDeadline,
        );
        progress[e.external_id] = { hash, id: res.data.id, action: "created", stage: "written", outcome: "retry", updated_at: now() };
        state.counts.created += 1;
      }
    } catch (err) {
      if (isFatal(err) || err instanceof OutOfRequests) throw err;
      if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while writing ${label}`;
      progress[e.external_id] = { hash, stage: "written", outcome: "failed", error: apiProblem(err), updated_at: now() };
      state.counts.failed += 1;
      state.problems.push(`- ${label}: failed, ${apiProblem(err)}`);
    }
    await save(state);
  }

  // Pass 2: references and media become ids, the values are written whole, the status is set.
  const resolver: Resolver = { cache: new Map() };
  for (const e of ctx.entries.rows) {
    const p = progress[e.external_id];
    if (!p || p.hash !== entryHash(e) || p.stage === "done" || !p.id || p.outcome === "failed" || p.outcome === "skipped") continue;
    if (Date.now() > state.deadline) return "the time for this call ran out while resolving the entries";
    if (!budgetLeft(4)) return REQUEST_BUDGET_SPENT;
    const label = `entry ${e.external_id} (${e.type})`;
    const warnings: string[] = [];
    try {
      const data = hasPortable(e.data) ? await resolvePortable(state, resolver, e.data, `${e.external_id} data`, warnings) : e.data;
      need(state, 1);
      await call(ctx.api, { method: "PATCH", path: `/entries/${encodeURIComponent(e.type)}/${p.id}`, body: { data, replace: true, ...(e.slug !== undefined ? { slug: e.slug } : {}) } }, state.hardDeadline);
      const step = entryLifecycle(e, opts);
      if (step === "publish") {
        need(state, 1);
        await call(ctx.api, { method: "POST", path: `/entries/${encodeURIComponent(e.type)}/${p.id}/publish`, body: {} }, state.hardDeadline);
        p.published = true;
        state.counts.published += 1;
        if (e.unpublish_at && Date.parse(e.unpublish_at) > Date.now()) {
          need(state, 1);
          await call(ctx.api, { method: "POST", path: `/entries/${encodeURIComponent(e.type)}/${p.id}/schedule-unpublish`, body: { at: e.unpublish_at } }, state.hardDeadline);
        }
      } else if (step === "schedule") {
        need(state, 1);
        await call(ctx.api, { method: "POST", path: `/entries/${encodeURIComponent(e.type)}/${p.id}/schedule`, body: { at: e.scheduled_at } }, state.hardDeadline);
        state.counts.scheduled += 1;
      }
      Object.assign(p, { stage: "done", outcome: "done", warnings: warnings.length ? warnings.slice(0, 10) : undefined, updated_at: now() });
      delete p.error;
      if (p.action === "updated") state.counts.updated += 1;
      state.warnings.push(...warnings.map((w) => `- ${w}`));
    } catch (err) {
      if (isFatal(err) || err instanceof OutOfRequests) throw err;
      if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while resolving ${label}`;
      // Written but not finished: it stays a draft (or as it was), and says why.
      Object.assign(p, { stage: "done", outcome: "failed", error: apiProblem(err), updated_at: now() });
      state.counts.failed += 1;
      state.problems.push(`- ${label}: its values or status could not be set, ${apiProblem(err)}${warnings.length ? ` (${warnings.join("; ")})` : ""}`);
    }
    await save(state);
  }
  await save(state, true);
  return null;
}

function entriesDryRun(ctx: Loaded, opts: ImportOptions): string[] {
  const e = ctx.entries;
  if (e.rows.length === 0 && e.problems.length === 0) return [];
  const byType = new Map<string, number>();
  for (const row of e.rows) byType.set(row.type, (byType.get(row.type) ?? 0) + 1);
  const publish = e.rows.filter((r) => entryLifecycle(r, opts) === "publish").length;
  const schedule = e.rows.filter((r) => entryLifecycle(r, opts) === "schedule").length;
  const withRefs = e.rows.filter((r) => hasPortable(r.data)).length;
  const lines = [
    "",
    `Entries: ${e.rows.length} (${[...byType].map(([t, n]) => `${n} ${t}`).join(", ")}), written after every article: matched by external_id, created as drafts, then their references and media resolved (${withRefs} have some) and their status set${opts.publish ? ` (${publish} to publish${schedule ? `, ${schedule} to schedule` : ""})` : " (none published: publish is false)"}. Each new entry is a document on the CMS meter.`,
  ];
  if (e.problems.length) lines.push(`Entries with problems, skipped (${e.problems.length}):`, ...listed(e.problems.map((x) => `- ${x}`), 20));
  return lines;
}

function entriesReport(ctx: Loaded): string[] {
  const rows = ctx.entries.rows;
  if (rows.length === 0 && ctx.entries.problems.length === 0) return [];
  const all = Object.values(ctx.progress.entries ?? {});
  const tally = (pred: (x: (typeof all)[number]) => boolean) => all.filter(pred).length;
  const lines = [
    "",
    `Entries: ${tally((x) => x.stage === "done" && x.outcome === "done")} of ${rows.length} done (created ${tally((x) => x.action === "created")}, updated ${tally((x) => x.action === "updated" && x.outcome === "done")}, published ${tally((x) => x.published === true)}, left unchanged ${tally((x) => x.outcome === "deferred")}, failed ${tally((x) => x.outcome === "failed")}).`,
  ];
  const attention = Object.entries(ctx.progress.entries ?? {})
    .filter(([, x]) => x.outcome === "failed" || x.outcome === "deferred")
    .map(([id, x]) => `- ${id}: ${x.outcome}, ${x.error ?? "no reason recorded"}`);
  if (attention.length) lines.push("Entries needing attention:", ...listed(attention, 20));
  if (ctx.entries.problems.length) lines.push(`Entries with problems, skipped (${ctx.entries.problems.length}):`, ...listed(ctx.entries.problems.map((x) => `- ${x}`), 20));
  return lines;
}

// ---- articles' custom fields ------------------------------------------------
function customFieldItems(ctx: Loaded): ValidItem[] {
  return ctx.valid.filter((v) => v.article.custom_fields && Object.keys(v.article.custom_fields).length > 0);
}

function customFieldsHash(v: ValidItem): string {
  return sha256(JSON.stringify(v.article.custom_fields));
}

function customFieldsPending(ctx: Loaded): boolean {
  return customFieldItems(ctx).some((v) => {
    const item = ctx.progress.items[v.article.external_id];
    if (!item?.article_id || item.outcome === "deferred" || item.outcome === "failed" || item.outcome === "skipped") return false;
    const p = ctx.progress.custom_fields?.[v.article.external_id];
    return !(p && p.hash === customFieldsHash(v) && (p.done || p.error));
  });
}

async function sendCustomFields(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  ctx.progress.custom_fields ??= {};
  const resolver: Resolver = { cache: new Map() };
  for (const v of customFieldItems(ctx)) {
    const item = ctx.progress.items[v.article.external_id];
    if (!item?.article_id || item.outcome === "deferred" || item.outcome === "failed" || item.outcome === "skipped") continue;
    const hash = customFieldsHash(v);
    const p = ctx.progress.custom_fields[v.article.external_id];
    if (p && p.hash === hash && (p.done || p.error)) continue;
    if (Date.now() > state.deadline) return "the time for this call ran out while setting the articles' custom fields";
    const max = state.opts.budget?.maxRequests;
    if (max !== undefined && requestsUsed(state) + 2 > max) return REQUEST_BUDGET_SPENT;
    const warnings: string[] = [];
    try {
      const values = await resolvePortable(state, resolver, v.article.custom_fields, `${v.article.external_id} custom_fields`, warnings);
      need(state, 1);
      await call(ctx.api, { method: "PATCH", path: `/articles/${item.article_id}`, body: { custom_fields: values } }, state.hardDeadline);
      ctx.progress.custom_fields[v.article.external_id] = { hash, done: true };
      state.warnings.push(...warnings.map((w) => `- ${w}`));
    } catch (err) {
      if (isFatal(err) || err instanceof OutOfRequests) throw err;
      if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while setting ${v.article.external_id}'s custom fields`;
      ctx.progress.custom_fields[v.article.external_id] = { hash, done: false, error: apiProblem(err) };
      state.problems.push(`- ${itemLabel(v.check)}: its custom fields were not set, ${apiProblem(err)}`);
    }
    await save(state);
  }
  await save(state, true);
  return null;
}

function customFieldsReport(ctx: Loaded): string[] {
  const items = customFieldItems(ctx);
  if (items.length === 0) return [];
  const done = items.filter((v) => ctx.progress.custom_fields?.[v.article.external_id]?.done).length;
  const failed = items.filter((v) => ctx.progress.custom_fields?.[v.article.external_id]?.error).length;
  return ["", `Articles' custom fields: set on ${done} of ${items.length}${failed ? `, ${failed} refused (listed above)` : ""}.`];
}

// ---------------------------------------------------------------------------
// The AI writing profile (PATCH /site/knowledge-profile)
// ---------------------------------------------------------------------------
/** GET /site/knowledge-profile, the parts the importer uses. `gaps` is absent on an older API. */
interface SiteProfile {
  product_knowledge: string | null;
  niche_keywords: string[];
  prompt_vars: Record<string, string>;
  gaps?: { complete: boolean; product_knowledge: boolean; niche_keywords: boolean; prompt_vars: string[] };
}

/** The Site's profile, or why it could not be read (a connection without site:read, say). */
async function readSiteProfile(api: ToolContext): Promise<SiteProfile | string> {
  try {
    const res = await call<SiteProfile>(api, { method: "GET", path: "/site/knowledge-profile" });
    return res.data ?? "the API returned no profile";
  } catch (err) {
    return apiProblem(err);
  }
}

/**
 * Drop the prompt variable names the Site does not know, each reported. The known names are the
 * Site's own answer (the ones it has set plus the ones it reports unset), so the list is never a
 * copy kept here. An older API that reports no gaps leaves the check to the PATCH.
 */
function checkProfileVars(check: ProfileCheck, site: SiteProfile): void {
  const vars = check.profile?.prompt_vars;
  if (!vars || !site.gaps) return;
  const known = new Set([...Object.keys(site.prompt_vars ?? {}), ...site.gaps.prompt_vars]);
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (known.has(k)) kept[k] = v;
    else check.problems.push(`profile.prompt_vars.${k}: not a prompt variable on this Site, so it is left out. Known: ${[...known].sort().join(", ")}`);
  }
  if (Object.keys(kept).length) check.profile!.prompt_vars = kept;
  else delete check.profile!.prompt_vars;
  if (Object.keys(check.profile!).length === 0) check.profile = null;
}

function profileHash(ctx: Loaded): string {
  return sha256(JSON.stringify(ctx.profile.profile));
}

/** The section has fields that have not been set, as the document now has them. */
function profilePending(ctx: Loaded): boolean {
  if (!ctx.profile.profile) return false;
  const p = ctx.progress.profile;
  return !(p && p.hash === profileHash(ctx) && p.done);
}

/** The Site refused this version of the section (recorded; retried once at the end of a call). */
function profileRefused(ctx: Loaded): boolean {
  const p = ctx.progress.profile;
  return profilePending(ctx) && !!p && p.hash === profileHash(ctx) && !!p.error;
}

/** The fields a profile section sets, as the reports name them. */
function profileFields(profile: NonNullable<ProfileCheck["profile"]>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(profile)) {
    if (k === "prompt_vars") out.push(...Object.keys(v as Record<string, string>).map((n) => `prompt_vars.${n}`));
    else if (v !== undefined) out.push(k);
  }
  return out;
}

/**
 * One PATCH with the fields the document has (prompt_vars merge name by name on the server, so
 * names left out keep the Site's value). Null, or why to stop. A missing scope or permission is
 * recorded, not fatal: the articles do not need the profile.
 */
async function sendProfile(state: ApplyState): Promise<string | null> {
  const { ctx } = state;
  const profile = ctx.profile.profile!;
  const hash = profileHash(ctx);
  ctx.progress.profile = { hash, done: false };
  const p = ctx.progress.profile;
  need(state, 1);
  try {
    await call(ctx.api, { method: "PATCH", path: "/site/knowledge-profile", body: profile }, state.hardDeadline);
    p.done = true;
    p.set = profileFields(profile);
  } catch (err) {
    if (isFatal(err) && err.code !== "INSUFFICIENT_SCOPE") throw err;
    if (isTransient(err)) return `the API was busy (${apiProblem(err)}) while setting the AI writing profile`;
    p.error = err instanceof WritavoApiError && err.code === "INSUFFICIENT_SCOPE"
      ? `this connection lacks site:write (${SCOPE_SCREEN["site:write"] ?? "Site settings, Read and write"}); ${ADD_ON_CONNECTION}`
      : apiProblem(err);
  }
  await save(state, true);
  return null;
}

/** What stays empty after the document's profile is set, from the Site's `gaps`. */
function gapsAfter(site: SiteProfile, profile: ProfileCheck["profile"]): string[] {
  const g = site.gaps!;
  const out: string[] = [];
  if (g.product_knowledge && !profile?.product_knowledge) out.push("product_knowledge");
  if (g.niche_keywords && !profile?.niche_keywords?.length) out.push("niche_keywords");
  const vars = g.prompt_vars.filter((k) => !profile?.prompt_vars?.[k]);
  if (vars.length) out.push(`${vars.length} prompt_vars (${vars.join(", ")})`);
  return out;
}

const PROFILE_GAP_ADVICE =
  "Until they are filled in, the AI pipeline writes with generic placeholders instead of the brand's details. Add them in a profile section of the document (import_content section \"profile\") and import again, or set them with the knowledge profile action (search_writavo_actions \"knowledge profile\"). Nothing needs them unless the AI pipeline is used.";

/** The dry run's view: what would be set, and what the profile would still lack afterwards. */
async function profileDryRun(ctx: Loaded): Promise<string[]> {
  const pr = ctx.profile;
  const lines = [""];
  if (pr.profile) {
    const fields = profileFields(pr.profile);
    lines.push(
      profilePending(ctx)
        ? `AI writing profile: sets ${fields.length} field${fields.length === 1 ? "" : "s"} (${fields.join(", ")}) before the articles. Fields the document leaves out keep what the Site has; nothing is cleared.`
        : "AI writing profile: already set by an earlier run.",
    );
  }
  if (pr.problems.length) lines.push(`AI writing profile problems, left out (${pr.problems.length}):`, ...listed(pr.problems.map((x) => `- ${x}`), 20));
  const site = ctx.siteProfile ?? (await readSiteProfile(ctx.api));
  if (typeof site === "string") {
    lines.push(`AI writing profile: the Site's profile could not be read (${site}), so what stays empty was not checked.`);
  } else if (site.gaps) {
    const left = gapsAfter(site, pr.profile);
    if (left.length) lines.push(`WARNING: after this import the AI writing profile is still empty in: ${left.join("; ")}. ${PROFILE_GAP_ADVICE}`);
    else if (pr.profile) lines.push("After this import the AI writing profile is complete.");
  }
  return lines.length > 1 ? lines : [];
}

/**
 * The apply reply's lines. `final` (the import is complete) reads the profile again and says
 * whether it still has gaps, whether or not the document had a profile section.
 */
async function profileReport(ctx: Loaded, final: boolean): Promise<string[]> {
  const p = ctx.progress.profile;
  const lines = [""];
  if (ctx.profile.profile) {
    if (p?.done && p.hash === profileHash(ctx)) lines.push(`AI writing profile: set (${(p.set ?? []).join(", ")}).`);
    else if (p?.error && p.hash === profileHash(ctx)) lines.push(`AI writing profile: NOT set, because ${p.error}. The articles are not affected; run the import again once that is fixed.`);
    else lines.push("AI writing profile: not set yet.");
  }
  if (ctx.profile.problems.length) lines.push(`AI writing profile problems, left out (${ctx.profile.problems.length}):`, ...listed(ctx.profile.problems.map((x) => `- ${x}`), 20));
  if (final) {
    const site = await readSiteProfile(ctx.api);
    if (typeof site === "string") {
      lines.push(`AI writing profile: could not be checked (${site}).`);
    } else if (site.gaps && !site.gaps.complete) {
      lines.push(`The AI writing profile is still incomplete: ${gapsAfter(site, null).join("; ")}. ${PROFILE_GAP_ADVICE}`);
    }
  }
  return lines.length > 1 ? lines : [];
}

/** Everything done since the last batch that the article counters do not show (the job runner's
 *  "did this batch move?"): content types, entries, custom fields, redirects, engagement and comments sent. */
function sectionWorkUnits(progress: ImportProgress | null): number {
  if (!progress) return 0;
  const entries = Object.values(progress.entries ?? {});
  return (
    (progress.content_types?.done ? 1 : 0) +
    entries.filter((e) => e.id).length +
    entries.filter((e) => e.stage === "done").length +
    Object.values(progress.custom_fields ?? {}).filter((c) => c.done || c.error).length +
    Object.values(progress.cost_history ?? {}).filter((c) => c.done).length +
    (progress.redirects?.sent ?? 0) +
    (progress.engagement ? progress.engagement.daily_sent + progress.engagement.reactions_sent : 0) +
    (progress.comments?.sent ?? 0) +
    (progress.seo ? progress.seo.competitors_sent + progress.seo.keywords_sent + progress.seo.positions_sent : 0) +
    (progress.profile?.done ? 1 : 0)
  );
}
