import type { z } from "zod/v4";
import {
  AuthorSchema,
  CategorySchema,
  EngagementDailySchema,
  EngagementReactionSchema,
  type EngagementDaily,
  type EngagementReaction,
  IMPORT_FORMAT_NAME,
  IMPORT_FORMAT_VERSION,
  ImportArticleSchema,
  ImportEnvelopeSchema,
  RedirectEntrySchema,
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

export interface RedirectsCheck {
  rows: RedirectEntry[];
  /** One line per skipped row, "redirects[3]: ...". Never blocks the articles. */
  problems: string[];
}

export interface DocumentCheck {
  envelope: ImportEnvelope | null;
  envelopeErrors: string[];
  items: ItemCheck[];
  engagement: EngagementCheck;
  redirects: RedirectsCheck;
}

const NO_ENGAGEMENT: EngagementCheck = { daily: [], reactions: [], problems: [] };
const NO_REDIRECTS: RedirectsCheck = { rows: [], problems: [] };

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
    if (d.day >= today) return void out.problems.push(`engagement.daily[${i}]: day ${d.day} is not a finished day; today is counted live from the blog and would overwrite it`);
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

export function describeIssue(issue: z.core.$ZodIssue): string {
  const where = pathLabel(issue.path);
  const message = /received undefined$/.test(issue.message) ? "is required" : issue.message;
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
  if (!Array.isArray(raw.articles) || raw.articles.length === 0) return null;
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
    ...(Array.isArray(raw.redirects) ? { redirects: raw.redirects as unknown[] } : {}),
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
      redirects: NO_REDIRECTS,
    };
  }

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
    redirects: checkRedirects(envelope.redirects),
  };
}
