import { COMMENT_LIMITS, IMPORT_FORMAT_NAME, IMPORT_FORMAT_VERSION, LIMITS, SLUG_PATTERN } from "../format.js";
import { commentHtmlToText, htmlToPlainText, wordpressHtmlToMarkdown } from "./html.js";
import type { WpAuthor, WpComment, WpExport, WpItem, WpSite, WpTerm } from "./model.js";
import type { Attachment } from "./shortcodes.js";

/**
 * A WordPress export -> a Writavo Import Format document, plus the report a person reads before
 * anything is written. The document goes through the ordinary importer (dry run, images copied,
 * redirects, re-runs update by external_id), so this file only decides WHAT each post becomes.
 *
 * Decisions (owner ruling 2026-09-28, CMS-PARITY.md M3):
 *   publish -> published, future -> scheduled, draft / pending / private -> draft (reported),
 *   a password-protected post -> draft with the password dropped (reported),
 *   trash / auto-draft / inherit -> left out. Private and password posts are never published by
 *   the import.
 *   One category per article until M4: Yoast's or Rank Math's primary category, else the first;
 *   the others are reported. Pages are left out and listed until M5.
 *   Each post's permalink and its ?p=<id> link become old_urls; category and tag archives become
 *   top-level redirects, so every URL the old blog answered keeps working.
 *   Comments (0160) on an imported post or page come too: approved, pending and spam as they were,
 *   the trash, pingbacks and trackbacks left out (counted in the report), each as plain text.
 */

export interface ConversionReport {
  source: "wordpress-wxr" | "wordpress-rest";
  site: string | null;
  /** Summary lines for the dry run. */
  lines: string[];
  /** Per-article notes, keyed by external_id, shown beside the article in the dry run. */
  items: Record<string, string[]>;
  counts: {
    posts: number;
    pages: number;
    published: number;
    scheduled: number;
    drafts: number;
    wordsChanged: number;
    skipped: Record<string, number>;
    /** Comments to import, and the ones left out by reason ("pingbacks and trackbacks": 3). */
    comments: number;
    commentsSkipped: Record<string, number>;
  };
}

export interface WordPressConversion {
  document: Record<string, unknown>;
  report: ConversionReport;
}

export interface MapOptions {
  source: ConversionReport["source"];
  /** WXR content is raw (wpautop + shortcodes needed); REST content is rendered. */
  rawContent: boolean;
  now?: number;
}

// ---- small helpers ----------------------------------------------------------------------------

/** WordPress's "YYYY-MM-DD HH:MM:SS" (GMT) -> ISO 8601 with Z, or null when unset. */
export function wpDate(value: string | null): string | null {
  if (!value || value.startsWith("0000-00-00")) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(value.trim());
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function decodeSlug(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A slug Writavo accepts: lower-case ASCII letters, digits and single hyphens. */
export function toSlug(raw: string, max: number = LIMITS.slug): string {
  return decodeSlug(raw)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const clip = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? "").trim();
  return t ? t.slice(0, max) : null;
};

function baseUrl(site: WpSite): string | null {
  const raw = site.baseBlogUrl ?? site.link ?? site.baseSiteUrl;
  return raw ? raw.replace(/\/+$/, "") : null;
}

/** Yoast (%%var%%) and Rank Math (%var%) title templates: the common variables resolved, else null. */
export function resolveTemplateText(
  value: string | undefined,
  vars: { title: string; sitename: string; excerpt: string },
): { value: string | null; dropped: boolean } {
  if (!value || !value.trim()) return { value: null, dropped: false };
  const known: Record<string, string> = { title: vars.title, sitename: vars.sitename, sep: "-", page: "", excerpt: vars.excerpt };
  let dropped = false;
  const out = value.replace(/%%([a-z_]+)%%|%([a-z_]+)%/gi, (_m, a: string | undefined, b: string | undefined) => {
    const name = (a ?? b ?? "").toLowerCase();
    if (name in known) return known[name]!;
    dropped = true;
    return "";
  });
  if (dropped) return { value: null, dropped: true };
  const clean = out.replace(/\s+/g, " ").replace(/^[\s-]+|[\s-]+$/g, "").trim();
  return { value: clean || null, dropped: false };
}

/** Rank Math stores robots as a PHP-serialised array: a:1:{i:0;s:7:"noindex";} */
const rankMathNoindex = (value: string | undefined) => Boolean(value && /"noindex"/.test(value));

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").toLowerCase() === b.replace(/\/+$/, "").toLowerCase();

// ---- comments (0160) ---------------------------------------------------------------------------

/** A WordPress comment's Writavo external_id, beside its post's "wp:<id>"; the two never collide. */
export const commentExternalId = (id: string) => `wp:comment:${id}`;

/** One comment row of the import document (POST /comments/import's CommentImportRow). */
export type CommentRow = Record<string, unknown> & { external_id: string };

export interface CommentsConverted {
  rows: CommentRow[];
  /** Left out, by reason: "pingbacks and trackbacks", "in the trash", "with no text"... */
  skipped: Record<string, number>;
  /** Notes for the post's line in the report (a comment too long to import, replies re-threaded). */
  notes: string[];
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const chars = (s: string) => [...s].length;
const EARLIEST_COMMENT = Date.UTC(1990, 0, 1);

/** wp:comment_approved -> the API's status, or null when the comment is left out. */
function commentStatus(approved: string): "approved" | "pending" | "spam" | null {
  if (approved === "1" || approved === "approve" || approved === "approved") return "approved";
  if (approved === "0" || approved === "hold") return "pending";
  if (approved === "spam") return "spam";
  return null;
}

const TOO_LONG = "longer than 20,000 characters";
const PINGBACKS = "pingbacks and trackbacks";

/** One comment's row, or why it is left out (the report's wording: "3 in the trash"). */
function commentRow(c: WpComment, postExternalId: string, raw: boolean, now: number): CommentRow | string {
  if (!/^[\x21-\x7E]{1,200}$/.test(c.id)) return "with no id";
  if (c.type === "pingback" || c.type === "trackback") return PINGBACKS;
  if (c.type !== "" && c.type !== "comment") return `of type ${c.type.slice(0, 40)}`;
  const status = commentStatus(c.approved.trim());
  if (!status) return c.approved === "trash" || c.approved === "post-trashed" ? "in the trash" : `with status ${c.approved.slice(0, 40) || "unknown"}`;
  const createdAt = wpDate(c.dateGmt) ?? wpDate(c.date);
  if (!createdAt) return "with no date";
  if (Date.parse(createdAt) < EARLIEST_COMMENT) return "dated before 1990";
  if (Date.parse(createdAt) > now + 5 * 60_000) return "dated in the future";
  const body = commentHtmlToText(c.content, raw);
  if (!body) return "with no text";
  if (chars(body) > COMMENT_LIMITS.body) return TOO_LONG;
  // The name as shown: entities decoded, spaces collapsed, cut to 80 characters (never dropped).
  const name = [...(htmlToPlainText(c.author) || "Anonymous")].slice(0, COMMENT_LIMITS.authorName).join("").trim() || "Anonymous";
  const email = (c.authorEmail ?? "").trim();
  return {
    external_id: commentExternalId(c.id),
    post_external_id: postExternalId,
    status,
    author_name: name,
    ...(email && email.length <= COMMENT_LIMITS.authorEmail && EMAIL.test(email) ? { author_email: email } : {}),
    body,
    created_at: createdAt,
  };
}

/**
 * One post's comments -> import rows. Every comment of a post is converted together, because a
 * reply to a comment that is left out (in the trash, a pingback) must still find a thread: it
 * replies to the nearest comment above it that is kept, or starts its own thread.
 */
export function convertComments(comments: WpComment[], postExternalId: string, raw: boolean, now: number): CommentsConverted {
  const out: CommentsConverted = { rows: [], skipped: {}, notes: [] };
  const skip = (why: string) => void (out.skipped[why] = (out.skipped[why] ?? 0) + 1);
  const parents = new Map<string, string | null>();
  for (const c of comments) if (c.id) parents.set(c.id, c.parentId && c.parentId !== "0" ? c.parentId : null);
  const kept: Array<{ c: WpComment; row: CommentRow }> = [];
  const seen = new Set<string>();
  for (const c of comments) {
    const id = c.id.trim();
    if (id && seen.has(id)) continue;
    seen.add(id);
    const row = commentRow({ ...c, id }, postExternalId, raw, now);
    if (typeof row === "string") {
      skip(row);
      if (row === TOO_LONG) out.notes.push(`comment ${commentExternalId(id)} is longer than 20,000 characters, so it is left out`);
      continue;
    }
    kept.push({ c: { ...c, id }, row });
  }
  const keptIds = new Set(kept.map((k) => k.c.id));
  let rethreaded = 0;
  for (const { c, row } of kept) {
    const direct = parents.get(c.id) ?? null;
    let parent = direct;
    for (let depth = 0; parent !== null && !keptIds.has(parent) && depth < 100; depth += 1) parent = parents.get(parent) ?? null;
    if (parent !== null && (!keptIds.has(parent) || parent === c.id)) parent = null;
    if (parent !== null) row.parent_external_id = commentExternalId(parent);
    if (direct !== null && parent !== direct) rethreaded += 1;
    out.rows.push(row);
  }
  if (rethreaded) out.notes.push(`${rethreaded === 1 ? "1 reply" : `${rethreaded} replies`} to a comment that is left out ${rethreaded === 1 ? "replies" : "reply"} to the nearest comment above it that is kept, or ${rethreaded === 1 ? "starts its" : "start their"} own thread`);
  return out;
}

function addCounts(into: Record<string, number>, from: Record<string, number> | undefined): void {
  for (const [why, n] of Object.entries(from ?? {})) into[why] = (into[why] ?? 0) + n;
}

const NOT_IMPORTED_POST = "on posts that are not imported";

// ---- the mapping, in three stages ------------------------------------------------------------
//
// contextOf -> convertPost (per post) -> assemble. The stages exist so a large export can be
// converted a batch at a time (the hosted import converts in its Durable Object's alarms, a few
// seconds of CPU each) with the same result as converting it in one go: everything a post's
// conversion needs from the rest of the export is in the context, which is plain data.

/** Everything in an export that is not a post or page: small, and all a post's conversion needs. */
export interface WpContext {
  site: WpSite;
  authors: WpAuthor[];
  terms: WpTerm[];
  attachments: Array<[string, Attachment]>;
  attachmentsByParent: Array<[string, string[]]>;
  /** Items left out before conversion (menus, custom post types, attachments' own count). */
  skipped: Record<string, number>;
}

/** Only these item types are converted; attachments feed the context. */
export const CONVERTED_TYPES = new Set(["post", "page"]);

export function emptyContext(): WpContext {
  return { site: { title: null, link: null, baseSiteUrl: null, baseBlogUrl: null }, authors: [], terms: [], attachments: [], attachmentsByParent: [], skipped: {} };
}

/** Add one non-post item to the context (an attachment, or something left out). */
export function addToContext(ctx: WpContext, item: WpItem): void {
  if (item.type === "attachment") {
    if (!item.attachmentUrl) return;
    ctx.attachments.push([item.id, { url: item.attachmentUrl, alt: item.meta["_wp_attachment_image_alt"]?.trim() || null }]);
    const parent = item.parentId;
    if (parent && parent !== "0") {
      const row = ctx.attachmentsByParent.find(([p]) => p === parent);
      if (row) row[1].push(item.id);
      else ctx.attachmentsByParent.push([parent, [item.id]]);
    }
    return;
  }
  const why = item.type || "unknown type";
  ctx.skipped[why] = (ctx.skipped[why] ?? 0) + 1;
}

export function contextOf(exp: WpExport): WpContext {
  const ctx: WpContext = { ...emptyContext(), site: exp.site, authors: exp.authors, terms: exp.terms };
  for (const item of exp.items) if (!CONVERTED_TYPES.has(item.type)) addToContext(ctx, item);
  return ctx;
}

interface Prepared {
  ctx: WpContext;
  site: string | null;
  sitename: string;
  attachments: Map<string, Attachment>;
  attachmentsByParent: Map<string, string[]>;
  categories: WpTerm[];
  tags: WpTerm[];
  catBySlug: Map<string, WpTerm>;
  catById: Map<string, WpTerm>;
  tagBySlug: Map<string, WpTerm>;
}

const cache = new WeakMap<WpContext, Prepared>();
function prepare(ctx: WpContext): Prepared {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const categories = ctx.terms.filter((t) => t.kind === "category");
  const tags = ctx.terms.filter((t) => t.kind === "post_tag");
  const p: Prepared = {
    ctx,
    site: baseUrl(ctx.site),
    sitename: ctx.site.title ?? "",
    attachments: new Map(ctx.attachments),
    attachmentsByParent: new Map(ctx.attachmentsByParent),
    categories,
    tags,
    catBySlug: new Map(categories.map((c) => [c.slug, c])),
    catById: new Map(categories.filter((c) => c.id).map((c) => [c.id!, c])),
    tagBySlug: new Map(tags.map((t) => [t.slug, t])),
  };
  cache.set(ctx, p);
  return p;
}

/** A term's Writavo slug: deterministic, so every batch agrees. */
function termSlug(t: WpTerm): string {
  return toSlug(t.slug, LIMITS.termSlug) || toSlug(t.name, LIMITS.termSlug) || `term-${t.id ?? toSlug(encodeURIComponent(t.slug)) ?? "x"}`;
}

/** One post, converted. Plain data: a batch stores these, and assemble reads them. */
export interface PostResult {
  kind: "article" | "skipped";
  skipReason?: string;
  externalId?: string;
  article?: Record<string, unknown>;
  notes: string[];
  wordsChanged: boolean;
  categories: string[];
  tags: string[];
  author: string | null;
  /** Its comments as import rows (a WXR post; the REST API's are converted in assemble). */
  comments?: CommentRow[];
  commentsSkipped?: Record<string, number>;
}

const LIVE_STATUSES = ["publish", "future", "draft", "pending", "private"];

export function convertPost(ctx: WpContext, item: WpItem, opts: MapOptions): PostResult {
  const p = prepare(ctx);
  const now = opts.now ?? Date.now();
  const lost = item.comments?.length ? { commentsSkipped: { [NOT_IMPORTED_POST]: item.comments.length } } : {};
  const none = { notes: [], wordsChanged: false, categories: [], tags: [], author: null, ...lost };
  // 0130: pages come across as Writavo pages, through the same conversion as posts.
  if (item.type !== "post" && item.type !== "page") return { ...none, kind: "skipped", skipReason: item.type || "unknown type" };
  const isPage = item.type === "page";
  if (!LIVE_STATUSES.includes(item.status)) return { ...none, kind: "skipped", skipReason: `${isPage ? "page" : "post"} with status ${item.status || "unknown"}` };
  if (!item.id) return { ...none, kind: "skipped", skipReason: "post without an id" };

  const externalId = `wp:${item.id}`;
  const notes: string[] = [];
  const title = htmlToPlainText(item.title);

  // Status.
  let status: "published" | "scheduled" | "draft" = item.status === "publish" ? "published" : item.status === "future" ? "scheduled" : "draft";
  if (item.status === "pending") notes.push("was pending review; imported as a draft");
  if (item.status === "private") notes.push("was private; imported as a draft, never published by the import");
  if (item.password) {
    notes.push(status !== "draft" ? "was password protected; imported as a draft and the password dropped" : "was password protected; the password is dropped");
    status = "draft";
  }

  // Body.
  const converted = wordpressHtmlToMarkdown(item.content, {
    raw: item.contentIsRaw ?? opts.rawContent,
    attachments: p.attachments,
    attachmentsByParent: p.attachmentsByParent,
    postId: item.id,
    siteUrl: p.site,
  });
  notes.push(...converted.warnings);

  // Slug: kept exactly when Writavo accepts it; otherwise the nearest it does, and the old
  // permalink redirects to it (old_urls below). Clashes between posts are settled in assemble.
  let slug = toSlug(item.slug);
  if (item.slug && slug !== decodeSlug(item.slug)) notes.push(`its slug "${decodeSlug(item.slug)}" becomes "${slug}"; the old URL redirects to the new one`);
  if (!slug) slug = toSlug(title) || `post-${item.id}`;

  if ((status === "published" || status === "scheduled") && (!title || !converted.markdown)) {
    notes.push(`has no ${!title ? "title" : "content"}, so it is imported as a draft`);
    status = "draft";
  }

  const article: Record<string, unknown> = { external_id: externalId, ...(isPage ? { kind: "page" } : {}), status, title: title || null, slug, content: converted.markdown || null };
  const excerpt = clip(htmlToPlainText(item.excerpt), LIMITS.excerpt);
  if (excerpt) article.excerpt = excerpt;

  // Dates.
  const publishedAt = wpDate(item.dateGmt) ?? wpDate(item.date);
  const modifiedAt = wpDate(item.modifiedGmt);
  if (status === "published") {
    if (!publishedAt) {
      notes.push("has no publication date in the export; imported as a draft");
      article.status = status = "draft";
    } else {
      if (!wpDate(item.dateGmt)) notes.push("its date has no timezone in the export and is read as UTC");
      article.published_at = Date.parse(publishedAt) > now ? new Date(now).toISOString() : publishedAt;
      if (modifiedAt && Date.parse(modifiedAt) >= Date.parse(publishedAt) && Date.parse(modifiedAt) <= now) article.content_updated_at = modifiedAt;
    }
  } else if (status === "scheduled") {
    if (publishedAt) article.scheduled_at = publishedAt;
    else {
      notes.push("was scheduled with no date in the export; imported as a draft");
      article.status = status = "draft";
    }
  }

  // Author (login is the ref; the email address is never read).
  if (item.creator) article.author = item.creator;

  // Categories (0129: several per article): the SEO plugin's primary category first, else the first
  // real one; every other category the post was filed under comes too.
  const cats = [...new Map(item.categories.map((s) => p.catBySlug.get(s)).filter((c): c is WpTerm => Boolean(c)).map((c) => [c.slug, c])).values()];
  const primaryId = item.meta["_yoast_wpseo_primary_category"] ?? item.meta["rank_math_primary_category"];
  const primary = (primaryId ? p.catById.get(primaryId.trim()) : undefined) ?? cats.find((c) => c.slug !== "uncategorized") ?? cats[0];
  if (primary && !isPage) {
    article.category = termSlug(primary);
    const others = cats.filter((c) => c.slug !== primary.slug).slice(0, 19);
    if (others.length) article.categories = others.map(termSlug);
  }
  const tagTerms = item.tags.map((s) => p.tagBySlug.get(s)).filter((t): t is WpTerm => Boolean(t));
  if (tagTerms.length && !isPage) article.tags = [...new Set(tagTerms.map(termSlug))];

  // Featured image.
  const thumbId = item.meta["_thumbnail_id"]?.trim();
  const thumb = thumbId ? p.attachments.get(thumbId) : undefined;
  if (thumb) article.featured_image = { url: thumb.url, ...(thumb.alt ? { alt: thumb.alt.slice(0, LIMITS.alt) } : {}) };
  else if (thumbId) notes.push("its featured image is not in the export");

  // SEO (Yoast, else Rank Math).
  const vars = { title, sitename: p.sitename, excerpt: excerpt ?? "" };
  const resolveTemplate = item.seoResolved
    ? (value: string | undefined) => ({ value: value?.trim() || null, dropped: false })
    : (value: string | undefined, v: typeof vars) => resolveTemplateText(value, v);
  const seoTitle = resolveTemplate(item.meta["_yoast_wpseo_title"] ?? item.meta["rank_math_title"], vars);
  if (seoTitle.value) article.seo_title = seoTitle.value.slice(0, LIMITS.seoTitle);
  const seoDesc = resolveTemplate(item.meta["_yoast_wpseo_metadesc"] ?? item.meta["rank_math_description"], vars);
  if (seoDesc.value) article.seo_description = seoDesc.value.slice(0, LIMITS.seoDescription);
  if (seoTitle.dropped || seoDesc.dropped) notes.push("an SEO title or description used template variables Writavo does not have; it is left for the default");
  const keyword = (item.meta["_yoast_wpseo_focuskw"] ?? item.meta["rank_math_focus_keyword"] ?? "").split(",")[0]?.trim();
  if (keyword) article.seo_keywords = [keyword];
  const canonical = (item.meta["_yoast_wpseo_canonical"] ?? item.meta["rank_math_canonical_url"] ?? "").trim();
  if (canonical && /^https?:\/\/\S+$/.test(canonical) && !(item.link && sameUrl(canonical, item.link))) {
    article.canonical_url = canonical.slice(0, LIMITS.url);
  }
  if (item.meta["_yoast_wpseo_meta-robots-noindex"] === "1" || rankMathNoindex(item.meta["rank_math_robots"])) article.noindex = true;
  const ogTitle = resolveTemplate(item.meta["_yoast_wpseo_opengraph-title"] ?? item.meta["rank_math_facebook_title"], vars);
  if (ogTitle.value) article.og_title = ogTitle.value.slice(0, LIMITS.seoTitle);
  const ogDesc = resolveTemplate(item.meta["_yoast_wpseo_opengraph-description"] ?? item.meta["rank_math_facebook_description"], vars);
  if (ogDesc.value) article.og_description = ogDesc.value.slice(0, LIMITS.seoDescription);
  const ogImage = (item.meta["_yoast_wpseo_opengraph-image"] ?? item.meta["rank_math_facebook_image"] ?? "").trim();
  if (/^https?:\/\/\S+$/.test(ogImage) && ogImage !== thumb?.url) article.og_image = { url: ogImage };

  // Every URL the post answered at: its permalink and its ?p=<id> link.
  const oldUrls = new Set<string>();
  if (item.link && /^https?:\/\//.test(item.link)) oldUrls.add(item.link);
  const shortLink = item.guid && /[?&]p=\d+/.test(item.guid) ? item.guid : p.site ? `${p.site}/?p=${item.id}` : null;
  if (shortLink) oldUrls.add(shortLink);
  if (oldUrls.size) article.old_urls = [...oldUrls].slice(0, 20);

  // Its readers' comments (WXR: stored raw, as typed).
  const comments = item.comments?.length ? convertComments(item.comments, externalId, opts.rawContent, now) : null;
  if (comments) notes.push(...comments.notes);

  return {
    kind: "article",
    externalId,
    article,
    ...(comments ? { comments: comments.rows, commentsSkipped: comments.skipped } : {}),
    notes,
    wordsChanged: converted.wordsChanged,
    categories: primary && !isPage ? [primary.slug, ...cats.filter((c) => c.slug !== primary.slug).map((c) => c.slug)] : [],
    tags: isPage ? [] : tagTerms.map((t) => t.slug),
    author: item.creator,
  };
}

/** The document and its report, from every post's result, in export order. */
export interface AssembleExtra {
  /** Comments read on their own (the REST API's, site-wide), each naming its post (postId). */
  comments?: WpComment[];
  /** Why the comments could not be read, when they could not (the REST endpoint was closed). */
  commentsNote?: string | null;
}

export function assemble(ctx: WpContext, results: PostResult[], opts: MapOptions, extra: AssembleExtra = {}): WordPressConversion {
  const p = prepare(ctx);
  const now = opts.now ?? Date.now();
  const comments: CommentRow[] = [];
  const commentsSkipped: Record<string, number> = {};
  const items: Record<string, string[]> = {};
  const skipped: Record<string, number> = { ...ctx.skipped };
  const usedCategories = new Set<string>();
  const usedTags = new Set<string>();
  const usedAuthors = new Set<string>();
  const articles: Record<string, unknown>[] = [];
  const seenSlugs = new Set<string>();
  let pagesImported = 0;
  let published = 0;
  let scheduled = 0;
  let drafts = 0;
  let wordsChanged = 0;

  for (const r of results) {
    addCounts(commentsSkipped, r.commentsSkipped);
    if (r.kind === "skipped" || !r.article || !r.externalId) {
      const why = r.skipReason ?? "unknown";
      skipped[why] = (skipped[why] ?? 0) + 1;
      continue;
    }
    if (r.comments) comments.push(...r.comments);
    const article = r.article;
    const notes = [...r.notes];
    let slug = String(article.slug);
    if (seenSlugs.has(slug)) {
      const id = r.externalId.slice(3);
      const unique = `${slug.slice(0, LIMITS.slug - id.length - 1)}-${id}`;
      notes.push(`its slug "${slug}" is used by another post in the export; it becomes "${unique}"`);
      slug = unique;
      article.slug = slug;
    }
    seenSlugs.add(slug);
    for (const c of r.categories) usedCategories.add(c);
    for (const t of r.tags) usedTags.add(t);
    if (r.author) usedAuthors.add(r.author);
    if (r.wordsChanged) wordsChanged += 1;
    if (article.kind === "page") pagesImported += 1;
    if (article.status === "published") published += 1;
    else if (article.status === "scheduled") scheduled += 1;
    else drafts += 1;
    articles.push(article);
    if (notes.length) items[r.externalId] = notes;
  }

  // Comments read on their own (REST), by post: only those on a post or page that is imported.
  if (extra.comments?.length) {
    const imported = new Set(articles.map((a) => String(a.external_id)));
    const byPost = new Map<string, WpComment[]>();
    for (const c of extra.comments) {
      const post = `wp:${c.postId ?? ""}`;
      const list = byPost.get(post);
      if (list) list.push(c);
      else byPost.set(post, [c]);
    }
    for (const [post, list] of byPost) {
      if (!imported.has(post)) {
        addCounts(commentsSkipped, { [NOT_IMPORTED_POST]: list.length });
        continue;
      }
      const converted = convertComments(list, post, false, now);
      comments.push(...converted.rows);
      addCounts(commentsSkipped, converted.skipped);
      if (converted.notes.length) items[post] = [...(items[post] ?? []), ...converted.notes];
    }
  }

  // Authors used by the imported posts. Name: the display name, else first + last, else the login.
  const authors: Record<string, unknown>[] = [];
  const known = new Set<string>();
  for (const a of ctx.authors) {
    if (!usedAuthors.has(a.login) || known.has(a.login)) continue;
    const name = a.displayName || [a.firstName, a.lastName].filter(Boolean).join(" ") || a.login;
    const slug = toSlug(a.login, LIMITS.authorSlug);
    authors.push({ ref: a.login, name: name.slice(0, LIMITS.authorName), ...(slug ? { slug } : {}), is_ai_generated: false });
    known.add(a.login);
  }
  for (const login of usedAuthors) {
    if (known.has(login)) continue;
    const slug = toSlug(login, LIMITS.authorSlug);
    authors.push({ ref: login, name: login.slice(0, LIMITS.authorName), ...(slug ? { slug } : {}), is_ai_generated: false });
    known.add(login);
  }

  const termEntry = (t: WpTerm) => ({
    slug: termSlug(t),
    name: (htmlToPlainText(t.name) || t.slug).slice(0, LIMITS.termName),
    ...(t.description ? { description: htmlToPlainText(t.description).slice(0, LIMITS.termDescription) } : {}),
  });
  // 0129: a used category brings its ancestors, so the tree comes across whole; each names its parent.
  const withAncestors = new Set<string>();
  for (const slug of usedCategories) {
    let c = p.catBySlug.get(slug);
    for (let depth = 0; c && depth < 10 && !withAncestors.has(c.slug); depth++) {
      withAncestors.add(c.slug);
      c = c.parent ? p.catBySlug.get(c.parent) : undefined;
    }
  }
  const docCategories = p.categories
    .filter((c) => withAncestors.has(c.slug))
    .map((c) => {
      const parent = c.parent ? p.catBySlug.get(c.parent) : undefined;
      return { ...termEntry(c), ...(parent && withAncestors.has(parent.slug) ? { parent: termSlug(parent) } : {}) };
    });
  const docTags = p.tags.filter((t) => usedTags.has(t.slug)).map(termEntry);

  // Archive URLs at WordPress's default bases (/category/, /tag/); the report says so.
  const catPath = (c: WpTerm, depth = 0): string => {
    const parent = c.parent && depth < 10 ? p.catBySlug.get(c.parent) : undefined;
    return parent ? `${catPath(parent, depth + 1)}/${decodeSlug(c.slug)}` : decodeSlug(c.slug);
  };
  const redirects: Record<string, unknown>[] = [];
  if (p.site) {
    for (const c of p.categories) {
      if (withAncestors.has(c.slug)) redirects.push({ from: `${p.site}/category/${catPath(c)}/`, to: `/category/${termSlug(c)}`, note: "WordPress category archive" });
    }
    for (const t of p.tags) {
      if (usedTags.has(t.slug)) redirects.push({ from: `${p.site}/tag/${decodeSlug(t.slug)}/`, to: `/tag/${termSlug(t)}`, note: "WordPress tag archive" });
    }
  }

  const QUIET = new Set(["nav_menu_item", "revision", "wp_navigation", "wp_global_styles", "wp_template", "wp_template_part", "customize_changeset", "custom_css", "oembed_cache", "user_request", "wp_block"]);
  const skippedLines = Object.entries(skipped)
    .filter(([why]) => !QUIET.has(why))
    .map(([why, n]) => `${n} ${why}`);
  const lines = [
    `Converted from a WordPress ${opts.source === "wordpress-wxr" ? "export file" : "site"}${p.sitename ? ` ("${p.sitename}")` : ""}: ${count(articles.length - pagesImported, "post")} and ${count(pagesImported, "page")} (${published} published, ${scheduled} scheduled, ${drafts} drafts). Pages keep their own addresses; a nested page (/about/team/) redirects to its new address (/team).`,
    ...(skippedLines.length ? [`Also left out: ${skippedLines.join(", ")}.`] : []),
    ...(redirects.length ? [`Archive redirects: ${redirects.length} category and tag archives at WordPress's default /category/ and /tag/ addresses. If the site changed those bases in Settings > Permalinks, add the real addresses as redirects after the import.`] : []),
    ...(wordsChanged ? [`${wordsChanged} post(s) may have changed text in conversion and are flagged below; check them before publishing.`] : []),
    ...commentLines(comments, commentsSkipped, opts, extra.commentsNote ?? null),
  ];

  const document: Record<string, unknown> = {
    format: IMPORT_FORMAT_NAME,
    version: IMPORT_FORMAT_VERSION,
    source: { name: `WordPress${p.sitename ? `: ${p.sitename}` : ""}`.slice(0, 200), ...(p.site ? { url: p.site.slice(0, LIMITS.url) } : {}) },
    ...(authors.length ? { authors } : {}),
    ...(docCategories.length ? { categories: docCategories } : {}),
    ...(docTags.length ? { tags: docTags } : {}),
    articles,
    ...(comments.length ? { comments } : {}),
    ...(redirects.length ? { redirects } : {}),
    // The report travels inside the document, so the dry run shows it wherever the document is kept.
    conversion: {
      from: opts.source,
      lines: lines.slice(0, 50).map((l) => l.slice(0, 2000)),
      items: Object.fromEntries(Object.entries(items).map(([k, v]) => [k, v.slice(0, 50).map((n) => n.slice(0, 2000))])),
    },
  };

  return {
    document,
    report: {
      source: opts.source,
      site: p.site,
      lines,
      items,
      counts: { posts: articles.length - pagesImported, pages: pagesImported, published, scheduled, drafts, wordsChanged, skipped, comments: comments.length, commentsSkipped },
    },
  };
}

/** The report's lines about comments: how many come, by status, and what is left out and why. */
function commentLines(rows: CommentRow[], skipped: Record<string, number>, opts: MapOptions, note: string | null): string[] {
  const lines: string[] = [];
  const left = Object.entries(skipped).map(([why, n]) => `${n} ${n === 1 && why === PINGBACKS ? "pingback or trackback" : why}`);
  if (rows.length || left.length) {
    const by = (s: string) => rows.filter((r) => r.status === s).length;
    const replies = rows.filter((r) => r.parent_external_id !== undefined).length;
    lines.push(
      `Comments: ${count(rows.length, "comment")} to import (${by("approved")} approved, ${by("pending")} pending, ${by("spam")} spam; ${replies} of them replies), as plain text, after the posts.${left.length ? ` Left out: ${left.join(", ")}.` : ""}`,
    );
  }
  if (note) lines.push(note);
  else if (opts.source === "wordpress-rest" && rows.length) {
    lines.push("Over the REST API WordPress shares only approved comments, without commenters' email addresses. To bring pending and spam comments and the addresses too, import an export file (Tools > Export) instead.");
  }
  return lines;
}

/** The whole export in one go (tests, small files). The same result as converting it in batches. */
export function mapWordPressExport(exp: WpExport, opts: MapOptions): WordPressConversion {
  const ctx = contextOf(exp);
  const results = exp.items.filter((i) => CONVERTED_TYPES.has(i.type)).map((i) => convertPost(ctx, i, opts));
  return assemble(ctx, results, opts);
}

export { SLUG_PATTERN };
