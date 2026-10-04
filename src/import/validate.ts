import type { z } from "zod/v4";
import {
  AuthorSchema,
  CategorySchema,
  CommentSchema,
  ContentTypeDefSchema,
  type ContentTypeDef,
  type ImportComment,
  EngagementDailySchema,
  EngagementReactionSchema,
  type EngagementDaily,
  type EngagementReaction,
  IMPORT_FORMAT_NAME,
  IMPORT_FORMAT_VERSION,
  ImportArticleSchema,
  ImportEntrySchema,
  ImportEnvelopeSchema,
  type ImportEntry,
  type ImportProfile,
  ProfileSchema,
  RedirectEntrySchema,
  SeoCompetitorSchema,
  SeoKeywordSchema,
  SeoPositionSchema,
  type SeoCompetitor,
  type SeoKeyword,
  type SeoPosition,
  TagSchema,
  type ImportArticle,
  type ImportEnvelope,
  type RedirectEntry,
} from "./format.js";

/**
 * Everything that can be decided about an import file without asking the Site. The checks that
 * need the Site (does this category exist there, is this format key real, is this slug taken)
 * live in the engine, next to the reads that answer them.
 */

export interface ItemCheck {
  /** Position in the file, for items whose external_id is itself the problem. */
  index: number;
  /** The external_id as written, when it is a string at all. */
  externalId: string | null;
  /** Null when the item did not parse; such an item is never written. */
  article: ImportArticle | null;
  errors: string[];
  warnings: string[];
}

export interface EngagementCheck {
  daily: EngagementDaily[];
  reactions: EngagementReaction[];
  /** One line per skipped row, "engagement.daily[3]: ...". Never blocks the articles. */
  problems: string[];
}

export interface CommentsCheck {
  /** The rows to send, in the order they must be sent: every parent before its replies. */
  rows: ImportComment[];
  /** One line per skipped row, "comments[3]: ...". Never blocks the articles. */
  problems: string[];
}

export interface SeoCheck {
  keywords: SeoKeyword[];
  competitors: SeoCompetitor[];
  positions: SeoPosition[];
  /** One line per skipped row, "seo.positions[3]: ...". Never blocks the articles. */
  problems: string[];
}

export interface RedirectsCheck {
  rows: RedirectEntry[];
  /** One line per skipped row, "redirects[3]: ...". Never blocks the articles. */
  problems: string[];
}

export interface ContentTypesCheck {
  types: ContentTypeDef[];
  /** One line per unusable type, "content_types[1]: ...". The Site's own dry run judges the fields. */
  problems: string[];
}

export interface EntriesCheck {
  rows: ImportEntry[];
  /** One line per skipped entry, "entries[3]: ...". Never blocks the articles. */
  problems: string[];
}

export interface ProfileCheck {
  /** The section as it will be sent, or null when the document has none (or it did not parse). */
  profile: ImportProfile | null;
  /** Why it will not be sent, "profile.prompt_vars.x: ...". Never blocks the articles. */
  problems: string[];
}

export interface DocumentCheck {
  envelope: ImportEnvelope | null;
  envelopeErrors: string[];
  items: ItemCheck[];
  engagement: EngagementCheck;
  comments: CommentsCheck;
  seo: SeoCheck;
  redirects: RedirectsCheck;
  contentTypes: ContentTypesCheck;
  entries: EntriesCheck;
  profile: ProfileCheck;
}

const NO_ENGAGEMENT: EngagementCheck = { daily: [], reactions: [], problems: [] };
const NO_COMMENTS: CommentsCheck = { rows: [], problems: [] };
const NO_SEO: SeoCheck = { keywords: [], competitors: [], positions: [], problems: [] };
const NO_REDIRECTS: RedirectsCheck = { rows: [], problems: [] };
const NO_TYPES: ContentTypesCheck = { types: [], problems: [] };
const NO_ENTRIES: EntriesCheck = { rows: [], problems: [] };
const NO_PROFILE: ProfileCheck = { profile: null, problems: [] };

/**
 * The AI writing profile section: all of it parses or none of it is sent (it is one PATCH). The
 * prompt variable names are checked against the Site in the engine, which knows them.
 */
export function checkProfile(raw: unknown): ProfileCheck {
  if (raw === undefined) return NO_PROFILE;
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    return { profile: null, problems: parsed.error.issues.map((x) => `profile: ${describeIssue(x)}`) };
  }
  if (Object.keys(parsed.data).length === 0) return { profile: null, problems: ["profile: is empty, so there is nothing to set"] };
  return { profile: parsed.data, problems: [] };
}

/** The content_types section: each must name itself; the fields are the Site's to judge (a dry run
 *  of POST /content-types/apply), so they are not second-guessed here. */
export function checkContentTypes(raw: unknown[] | undefined): ContentTypesCheck {
  if (!raw) return NO_TYPES;
  const out: ContentTypesCheck = { types: [], problems: [] };
  const seen = new Set<string>();
  raw.forEach((row, i) => {
    const parsed = ContentTypeDefSchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`content_types[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    if (seen.has(parsed.data.api_id)) return void out.problems.push(`content_types[${i}]: "${parsed.data.api_id}" appears more than once`);
    seen.add(parsed.data.api_id);
    // The row as written (fields and all), not the parsed copy: the Site checks every key.
    out.types.push(row as ContentTypeDef);
  });
  return out;
}

/** The entries section, row by row: a bad entry is reported and skipped. */
export function checkEntries(raw: unknown[] | undefined, types: ContentTypesCheck, now = Date.now()): EntriesCheck {
  if (!raw) return NO_ENTRIES;
  const out: EntriesCheck = { rows: [], problems: [] };
  const seen = new Set<string>();
  const componentTypes = new Set(types.types.filter((t) => t.kind === "component" || t.kind === "article_fields").map((t) => t.api_id));
  raw.forEach((row, i) => {
    const parsed = ImportEntrySchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`entries[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    const e = parsed.data;
    if (seen.has(e.external_id)) return void out.problems.push(`entries[${i}]: external_id "${e.external_id}" appears more than once`);
    seen.add(e.external_id);
    if (componentTypes.has(e.type)) return void out.problems.push(`entries[${i}]: "${e.type}" is a ${types.types.find((t) => t.api_id === e.type)!.kind} type, which has no entries`);
    if (e.status === "scheduled" && e.scheduled_at && Date.parse(e.scheduled_at) <= now) {
      out.problems.push(`entries[${i}]: scheduled_at ${e.scheduled_at} has passed, so ${e.external_id} is imported as a draft`);
      out.rows.push({ ...e, status: "draft", scheduled_at: undefined });
      return;
    }
    out.rows.push(e);
  });
  return out;
}

/** The optional redirects section, row by row: a bad row is reported and skipped. */
export function checkRedirects(raw: unknown[] | undefined): RedirectsCheck {
  if (!raw) return NO_REDIRECTS;
  const out: RedirectsCheck = { rows: [], problems: [] };
  raw.forEach((row, i) => {
    const parsed = RedirectEntrySchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`redirects[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    out.rows.push(parsed.data);
  });
  return out;
}

/**
 * The optional engagement section, row by row: a bad row is reported and skipped, never a reason
 * to refuse the document. Whether the post is on the Site is checked later, in the engine and by
 * the API.
 */
export function checkEngagement(raw: { daily?: unknown[]; reactions?: unknown[] } | undefined, now = Date.now()): EngagementCheck {
  if (!raw) return NO_ENGAGEMENT;
  const out: EngagementCheck = { daily: [], reactions: [], problems: [] };
  const today = new Date(now).toISOString().slice(0, 10);
  const seenDays = new Set<string>();
  (raw.daily ?? []).forEach((row, i) => {
    const parsed = EngagementDailySchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`engagement.daily[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    const d = parsed.data;
    if (d.day > today) return void out.problems.push(`engagement.daily[${i}]: day ${d.day} is in the future`);
    if (d.day < "1990-01-01") return void out.problems.push(`engagement.daily[${i}]: day ${d.day} is before 1990`);
    const key = `${d.external_id ?? `slug:${d.slug}`}|${d.day}`;
    if (seenDays.has(key)) return void out.problems.push(`engagement.daily[${i}]: a second row for the same post and day ${d.day}; each day appears once`);
    seenDays.add(key);
    out.daily.push(d);
  });
  const seenPicks = new Set<string>();
  (raw.reactions ?? []).forEach((row, i) => {
    const parsed = EngagementReactionSchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`engagement.reactions[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    const r = parsed.data;
    if (Date.parse(r.set_at) > now) return void out.problems.push(`engagement.reactions[${i}]: set_at is in the future`);
    const key = `${r.external_id ?? `slug:${r.slug}`}|${r.visitor_id}`;
    if (seenPicks.has(key)) return void out.problems.push(`engagement.reactions[${i}]: a second pick by the same visitor on the same post; a visitor has one current pick`);
    seenPicks.add(key);
    out.reactions.push(r);
  });
  return out;
}

/** The API refuses a comment dated before this or after now (0160 comment_import_row_error). */
const EARLIEST_COMMENT = Date.UTC(1990, 0, 1);

/**
 * The optional comments section, row by row: a bad row is reported and skipped, never a reason to
 * refuse the document. The rows that pass come back in SENDING order (orderComments). Whether the
 * post is on the Site is the API's to answer, after the articles are written.
 */
export function checkComments(raw: unknown[] | undefined, now = Date.now()): CommentsCheck {
  if (!raw) return NO_COMMENTS;
  const out: CommentsCheck = { rows: [], problems: [] };
  const seen = new Set<string>();
  const kept: ImportComment[] = [];
  raw.forEach((row, i) => {
    const parsed = CommentSchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`comments[${i}]: ${parsed.error.issues.map((x) => describeIssue(x, true)).join("; ")}`);
      return;
    }
    const c = parsed.data;
    const at = Date.parse(c.created_at);
    if (at < EARLIEST_COMMENT || at > now + 5 * 60_000) return void out.problems.push(`comments[${i}]: created_at must be between 1990 and now`);
    if (c.parent_external_id != null && c.parent_external_id === c.external_id) return void out.problems.push(`comments[${i}]: a comment cannot be its own parent`);
    if (seen.has(c.external_id)) return void out.problems.push(`comments[${i}]: external_id "${c.external_id}" appears more than once`);
    seen.add(c.external_id);
    kept.push(c);
  });
  const ordered = orderComments(kept);
  out.rows = ordered.rows;
  for (const c of ordered.looped) out.problems.push(`comment ${c.external_id}: its replies loop back to it (a parent chain that never reaches a top-level comment)`);
  return out;
}

/**
 * The order comments are sent in: the API takes a reply only once its parent exists, so parents go
 * first. Top-level comments (no parent, or a parent outside this document, which must then already
 * be on the Site) by created_at, then their replies by created_at, then replies to those, and so
 * on. Sending in this order, a chunk at a time, never puts a reply in an earlier chunk than its
 * parent. A chain that loops never reaches a top-level comment; those rows are returned apart.
 */
export function orderComments(rows: ImportComment[]): { rows: ImportComment[]; looped: ImportComment[] } {
  const ids = new Set(rows.map((c) => c.external_id));
  const children = new Map<string, ImportComment[]>();
  let level: ImportComment[] = [];
  for (const c of rows) {
    const parent = c.parent_external_id ?? null;
    if (parent === null || !ids.has(parent)) level.push(c);
    else {
      const list = children.get(parent);
      if (list) list.push(c);
      else children.set(parent, [c]);
    }
  }
  // Stable: rows written at the same moment keep their document order.
  const byDate = (list: ImportComment[]) =>
    list
      .map((c, i) => ({ c, i, at: Date.parse(c.created_at) }))
      .sort((a, b) => a.at - b.at || a.i - b.i)
      .map((x) => x.c);
  const out: ImportComment[] = [];
  const placed = new Set<string>();
  while (level.length) {
    const sorted = byDate(level);
    out.push(...sorted);
    for (const c of sorted) placed.add(c.external_id);
    level = sorted.flatMap((c) => children.get(c.external_id) ?? []);
  }
  return { rows: out, looped: rows.filter((c) => !placed.has(c.external_id)) };
}

/** A keyword as POST /seo/keywords stores it (trimmed, inner whitespace collapsed), for matching. */
export function seoKeywordKey(keyword: string): string {
  return keyword.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A competitor domain as POST /seo/competitors compares it: the bare host, without www. Only
 *  for spotting a repeat in the document; the API does the full normalisation. */
function seoDomainKey(domain: string): string {
  return domain.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/^.*@/, "").replace(/:\d*$/, "").replace(/\.$/, "").replace(/^www\./, "");
}

/**
 * The optional SEO section, row by row: a bad row is reported and skipped, never a reason to
 * refuse the document. Whether a position's keyword is on the Site, and the plan's keyword limit,
 * are the API's to answer (the engine asks it in the dry run).
 */
export function checkSeo(raw: { keywords?: unknown[]; competitors?: unknown[]; positions?: unknown[] } | undefined, now = Date.now()): SeoCheck {
  if (!raw) return NO_SEO;
  const out: SeoCheck = { keywords: [], competitors: [], positions: [], problems: [] };
  const today = new Date(now).toISOString().slice(0, 10);
  const seenKeywords = new Set<string>();
  (raw.keywords ?? []).forEach((row, i) => {
    const parsed = SeoKeywordSchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`seo.keywords[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    const key = seoKeywordKey(parsed.data.keyword);
    if (!key) return void out.problems.push(`seo.keywords[${i}]: keyword is only spaces`);
    if (seenKeywords.has(key)) return void out.problems.push(`seo.keywords[${i}]: "${parsed.data.keyword}" appears more than once (keywords match ignoring case)`);
    seenKeywords.add(key);
    out.keywords.push(parsed.data);
  });
  const seenDomains = new Set<string>();
  (raw.competitors ?? []).forEach((row, i) => {
    const parsed = SeoCompetitorSchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`seo.competitors[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    const key = seoDomainKey(parsed.data.domain);
    if (seenDomains.has(key)) return void out.problems.push(`seo.competitors[${i}]: ${key} appears more than once`);
    seenDomains.add(key);
    out.competitors.push(parsed.data);
  });
  const seenDays = new Set<string>();
  (raw.positions ?? []).forEach((row, i) => {
    const parsed = SeoPositionSchema.safeParse(row);
    if (!parsed.success) {
      out.problems.push(`seo.positions[${i}]: ${parsed.error.issues.map((x) => describeIssue(x)).join("; ")}`);
      return;
    }
    const d = parsed.data;
    if (d.day >= today) return void out.problems.push(`seo.positions[${i}]: day ${d.day} is not a finished day; import days before today (UTC), so a rank check made today is never overwritten`);
    if (d.day < "2000-01-01") return void out.problems.push(`seo.positions[${i}]: day ${d.day} is before 2000`);
    const key = `${seoKeywordKey(d.keyword)}|${d.day}`;
    if (seenDays.has(key)) return void out.problems.push(`seo.positions[${i}]: a second row for "${d.keyword}" on ${d.day}; each keyword has one position per day`);
    seenDays.add(key);
    out.positions.push(d);
  });
  return out;
}

/** The Writavo API refuses an original date before this (articleLifecycle.ts readPastDate). */
export const EARLIEST_ORIGINAL_DATE = Date.UTC(1990, 0, 1);

function pathLabel(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out ? `.${String(part)}` : String(part);
  }
  return out;
}

/**
 * One zod issue as a line. `selfNamed`: the schema's messages already name their field, in the
 * API's own wording ("author_name is required, 1 to 80 characters"), so the path is not repeated.
 */
export function describeIssue(issue: z.core.$ZodIssue, selfNamed = false): string {
  const where = pathLabel(issue.path);
  const message = /received undefined$/.test(issue.message) ? "is required" : issue.message;
  if (selfNamed && where && message.includes(where)) return message;
  return where ? `${where}: ${message}` : message;
}

export function itemLabel(item: Pick<ItemCheck, "index" | "externalId">): string {
  return item.externalId ? `${item.externalId} (articles[${item.index}])` : `articles[${item.index}]`;
}

/**
 * The top level with every entry that parses kept and every one that does not reported, so one
 * bad author, category or tag no longer hides the articles' own problems: the dry run reports
 * both in one pass. Null only when there is nothing to check the articles against (not an object,
 * or no articles array).
 */
function salvageEnvelope(value: unknown): ImportEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.articles)) return null;
  const keep = <T>(entries: unknown, schema: z.ZodType<T>): T[] | undefined =>
    Array.isArray(entries)
      ? entries.flatMap((entry) => {
          const parsed = schema.safeParse(entry);
          return parsed.success ? [parsed.data] : [];
        })
      : undefined;
  return {
    format: IMPORT_FORMAT_NAME,
    version: IMPORT_FORMAT_VERSION,
    authors: keep(raw.authors, AuthorSchema),
    categories: keep(raw.categories, CategorySchema),
    tags: keep(raw.tags, TagSchema),
    ...(raw.engagement && typeof raw.engagement === "object" && !Array.isArray(raw.engagement)
      ? { engagement: raw.engagement as { daily?: unknown[]; reactions?: unknown[] } }
      : {}),
    ...(Array.isArray(raw.comments) ? { comments: raw.comments as unknown[] } : {}),
    ...(raw.seo && typeof raw.seo === "object" && !Array.isArray(raw.seo)
      ? { seo: raw.seo as { keywords?: unknown[]; competitors?: unknown[]; positions?: unknown[] } }
      : {}),
    ...(Array.isArray(raw.redirects) ? { redirects: raw.redirects as unknown[] } : {}),
    ...(Array.isArray(raw.content_types) ? { content_types: raw.content_types as unknown[] } : {}),
    ...(Array.isArray(raw.entries) ? { entries: raw.entries as unknown[] } : {}),
    ...(raw.profile !== undefined ? { profile: raw.profile } : {}),
    articles: raw.articles,
  };
}

export function checkDocument(value: unknown, now = Date.now()): DocumentCheck {
  const envelopeResult = ImportEnvelopeSchema.safeParse(value);
  // Article-level issues are not the envelope's; they are reported per item below.
  const envelopeErrors: string[] = envelopeResult.success
    ? []
    : envelopeResult.error.issues
        .filter((issue) => issue.path[0] !== "articles" || issue.path.length === 1)
        .map((issue) => describeIssue(issue));
  const envelope = envelopeResult.success ? envelopeResult.data : salvageEnvelope(value);
  if (!envelope) {
    return {
      envelope: null,
      envelopeErrors: envelopeErrors.length > 0 ? envelopeErrors : ["The file is not a Writavo import document."],
      items: [],
      engagement: NO_ENGAGEMENT,
      comments: NO_COMMENTS,
      seo: NO_SEO,
      redirects: NO_REDIRECTS,
      contentTypes: NO_TYPES,
      entries: NO_ENTRIES,
      profile: NO_PROFILE,
    };
  }
  const hasSomething =
    envelope.articles.length > 0 || (envelope.entries?.length ?? 0) > 0 || (envelope.content_types?.length ?? 0) > 0 ||
    (envelope.redirects?.length ?? 0) > 0 || (envelope.engagement?.daily?.length ?? 0) + (envelope.engagement?.reactions?.length ?? 0) > 0 ||
    (envelope.comments?.length ?? 0) > 0 ||
    (envelope.seo?.keywords?.length ?? 0) + (envelope.seo?.competitors?.length ?? 0) + (envelope.seo?.positions?.length ?? 0) > 0 ||
    envelope.profile !== undefined;
  if (!hasSomething) envelopeErrors.push("The document has nothing to import: no articles, entries, content types, redirects, engagement, comments, SEO data or profile.");

  const duplicates = (values: string[], what: string) => {
    const seen = new Set<string>();
    for (const v of values) {
      if (seen.has(v)) envelopeErrors.push(`${what} "${v}" appears more than once`);
      seen.add(v);
    }
  };
  duplicates((envelope.authors ?? []).map((a) => a.ref), "authors[].ref");
  duplicates((envelope.categories ?? []).map((c) => c.slug), "categories[].slug");
  duplicates((envelope.tags ?? []).map((t) => t.slug), "tags[].slug");

  // Every ref the document declares, parseable or not: an article naming an author whose entry has
  // a problem is reported once, against the author, not a second time against the article.
  const rawAuthors = (value as { authors?: unknown }).authors;
  const authorRefs = new Set(
    Array.isArray(rawAuthors)
      ? rawAuthors.flatMap((a) => (a && typeof a === "object" && typeof (a as { ref?: unknown }).ref === "string" ? [(a as { ref: string }).ref] : []))
      : [],
  );
  const seenExternalIds = new Map<string, number>();
  const seenSlugs = new Map<string, number>();

  const contentTypes = checkContentTypes(envelope.content_types);
  const items: ItemCheck[] = envelope.articles.map((raw, index) => {
    const externalId =
      raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).external_id === "string"
        ? ((raw as Record<string, unknown>).external_id as string)
        : null;
    const check: ItemCheck = { index, externalId, article: null, errors: [], warnings: [] };

    const status = raw && typeof raw === "object" ? (raw as Record<string, unknown>).status : undefined;
    if (status !== "published" && status !== "draft" && status !== "scheduled") {
      check.errors.push(`status: must be "published", "draft" or "scheduled"${status === undefined ? "" : `, not ${JSON.stringify(status)}`}`);
      return check;
    }

    const parsed = ImportArticleSchema.safeParse(raw);
    if (!parsed.success) {
      check.errors.push(...parsed.error.issues.map((issue) => describeIssue(issue)));
      return check;
    }
    const article = parsed.data;
    check.article = article;

    const firstId = seenExternalIds.get(article.external_id);
    if (firstId !== undefined) {
      check.errors.push(`external_id: also used by articles[${firstId}]; each article needs its own`);
    } else {
      seenExternalIds.set(article.external_id, index);
    }
    if (article.slug) {
      const firstSlug = seenSlugs.get(article.slug);
      if (firstSlug !== undefined) check.errors.push(`slug: "${article.slug}" is also used by articles[${firstSlug}]`);
      else seenSlugs.set(article.slug, index);
    }

    if (article.author !== undefined && !authorRefs.has(article.author)) {
      check.errors.push(`author: "${article.author}" is not an authors[].ref in this file`);
    }

    const published = article.published_at ? Date.parse(article.published_at) : null;
    const updated = article.content_updated_at ? Date.parse(article.content_updated_at) : null;
    if (article.status === "published") {
      if (published !== null && published > now) {
        check.errors.push("published_at: is in the future. Use the original publication date; to go live later, import it as a draft and schedule it.");
      }
      if (published !== null && published < EARLIEST_ORIGINAL_DATE) {
        check.errors.push("published_at: is before 1990-01-01, which is almost always a missing date read as zero");
      }
      if (updated !== null && updated > now) check.errors.push("content_updated_at: is in the future");
      if (updated !== null && published !== null && updated < published) {
        check.errors.push("content_updated_at: is before published_at");
      }
    } else if (article.published_at || article.content_updated_at) {
      check.warnings.push(
        article.status === "scheduled"
          ? "published_at and content_updated_at are ignored on a scheduled article; it goes live at scheduled_at"
          : "published_at and content_updated_at are ignored on a draft; it is imported unpublished",
      );
    }
    if (article.status === "scheduled" && Date.parse(article.scheduled_at) <= now) {
      check.warnings.push(`scheduled_at ${article.scheduled_at} has passed, so it is imported as a draft; publish or schedule it after the import`);
    }

    if (article.comparison) {
      const width = article.comparison.headers.length;
      const ragged = article.comparison.rows.findIndex((row) => row.length !== width);
      if (ragged !== -1) {
        check.warnings.push(`comparison.rows[${ragged}] has ${article.comparison.rows[ragged]!.length} cells for ${width} headers`);
      }
    }
    return check;
  });

  return {
    envelope,
    envelopeErrors,
    items,
    engagement: checkEngagement(envelope.engagement, now),
    comments: checkComments(envelope.comments, now),
    seo: checkSeo(envelope.seo, now),
    redirects: checkRedirects(envelope.redirects),
    contentTypes,
    entries: checkEntries(envelope.entries, contentTypes, now),
    profile: checkProfile(envelope.profile),
  };
}
