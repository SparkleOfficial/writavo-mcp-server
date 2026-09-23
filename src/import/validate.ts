import type { z } from "zod/v4";
import {
  ImportArticleSchema,
  ImportEnvelopeSchema,
  type ImportArticle,
  type ImportEnvelope,
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

export interface DocumentCheck {
  envelope: ImportEnvelope | null;
  envelopeErrors: string[];
  items: ItemCheck[];
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

export function checkDocument(value: unknown, now = Date.now()): DocumentCheck {
  const envelopeResult = ImportEnvelopeSchema.safeParse(value);
  if (!envelopeResult.success) {
    // Article-level issues are not the envelope's; they are reported per item below. But an
    // envelope that does not parse leaves nothing to check the items against.
    const errors = envelopeResult.error.issues
      .filter((issue) => issue.path[0] !== "articles" || issue.path.length === 1)
      .map((issue) => describeIssue(issue));
    if (errors.length > 0) return { envelope: null, envelopeErrors: errors, items: [] };
  }
  const envelope = envelopeResult.success ? envelopeResult.data : null;
  if (!envelope) return { envelope: null, envelopeErrors: ["The file is not a Writavo import document."], items: [] };

  const envelopeErrors: string[] = [];
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

  const authorRefs = new Set((envelope.authors ?? []).map((a) => a.ref));
  const seenExternalIds = new Map<string, number>();
  const seenSlugs = new Map<string, number>();

  const items: ItemCheck[] = envelope.articles.map((raw, index) => {
    const externalId =
      raw && typeof raw === "object" && typeof (raw as Record<string, unknown>).external_id === "string"
        ? ((raw as Record<string, unknown>).external_id as string)
        : null;
    const check: ItemCheck = { index, externalId, article: null, errors: [], warnings: [] };

    const status = raw && typeof raw === "object" ? (raw as Record<string, unknown>).status : undefined;
    if (status !== "published" && status !== "draft") {
      check.errors.push(`status: must be "published" or "draft"${status === undefined ? "" : `, not ${JSON.stringify(status)}`}`);
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
      check.warnings.push("published_at and content_updated_at are ignored on a draft; it is imported unpublished");
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

  return { envelope, envelopeErrors, items };
}
