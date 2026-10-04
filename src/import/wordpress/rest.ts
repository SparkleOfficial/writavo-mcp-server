import { addToContext, emptyContext, type WpContext } from "./map.js";
import type { WpComment, WpItem, WpTerm } from "./model.js";
import { commentsKey, CTX, inKey, PAGE_POSTS_STAGED, STATE, type StageState, type StageStore } from "./staged.js";

/**
 * A live WordPress site read over its REST API (CMS-PARITY.md M3, the second source after a WXR
 * file), staged exactly like an uploaded export so the same batched conversion finishes it.
 *
 * Read only: GET requests, nothing else. Published posts are public; drafts, scheduled, pending
 * and private posts need an Application Password (Users > Profile), sent as basic auth. The
 * password is used for this pull only; the host keeps it sealed and erases it when the pull ends.
 *
 * The pull is RESUMABLE: each step makes at most `maxRequests` requests (a free-plan Worker
 * invocation may make about 50) and records its cursor, and the host calls again until done.
 *
 * Comments (0160) are read last, site-wide (/wp/v2/comments): the public API gives approved
 * comments only, without email addresses. A site that does not share them (401, 403, 404, or
 * anything else) gets a note in the report; the posts are imported either way.
 */

export interface WordPressSite {
  url: string;
  username?: string;
  applicationPassword?: string;
}

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export interface PullCursor {
  phase: "categories" | "tags" | "posts" | "pages" | "comments" | "done";
  page: number;
  totalPages: number | null;
  /** Posts staged so far, and the page of staged posts being filled. */
  pending: WpItem[];
}

export interface PullState {
  base: string;
  authed: boolean;
  cursor: PullCursor;
  requests: number;
}

const PER_PAGE = 100;
const USER_AGENT = "Writavo-Importer/1.0 (+https://writavo.com/docs/migrate)";

/** The site's REST root for a URL a person typed (with or without a path or trailing slash). */
export function restBase(input: string): { base: string } | { error: string } {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(input.trim()) ? input.trim() : `https://${input.trim()}`);
  } catch {
    return { error: "The WordPress address is not a valid URL." };
  }
  if (u.protocol !== "https:") return { error: "The WordPress address must be https." };
  if (u.username || u.password) return { error: "Put the user name and application password in their own fields, not in the address." };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { error: "The WordPress address must be a public domain name." };
  }
  const path = u.pathname.replace(/\/wp-json.*$/, "").replace(/\/+$/, "");
  return { base: `${u.origin}${path}` };
}

function headers(site: WordPressSite): Record<string, string> {
  const h: Record<string, string> = { Accept: "application/json", "User-Agent": USER_AGENT };
  if (site.username && site.applicationPassword) {
    h.Authorization = `Basic ${btoa(`${site.username}:${site.applicationPassword.replace(/\s+/g, "")}`)}`;
  }
  return h;
}

async function getJson(fetcher: Fetcher, url: string, site: WordPressSite): Promise<{ data: unknown; totalPages: number | null; total: number | null }> {
  const res = await fetcher(url, { headers: headers(site) });
  if (res.status === 401 || res.status === 403) {
    throw new PullError(site.applicationPassword ? "WordPress refused the user name and application password." : "WordPress refused the request. The REST API may be restricted on this site; export a file from Tools > Export instead.");
  }
  if (res.status === 404) throw new PullError("This address has no WordPress REST API (wp-json). Check the address, or export a file from Tools > Export instead.");
  if (!res.ok) throw new PullError(`WordPress answered ${res.status} for ${new URL(url).pathname}.`);
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("json")) throw new PullError("The address did not answer as a WordPress REST API (it returned a web page). A security plugin or firewall may be blocking it; export a file from Tools > Export instead.");
  const totalPages = Number(res.headers.get("x-wp-totalpages"));
  const total = Number(res.headers.get("x-wp-total"));
  return { data: await res.json(), totalPages: Number.isFinite(totalPages) && totalPages > 0 ? totalPages : null, total: Number.isFinite(total) ? total : null };
}

export class PullError extends Error {}

const text = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { rendered?: unknown }).rendered === "string" ? (v as { rendered: string }).rendered : "");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** "2021-03-04T09:30:00" (REST, GMT, no suffix) -> the WXR form the mapping reads. */
const restDate = (v: unknown): string | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? v.slice(0, 19).replace("T", " ") : null);

/** The REST API's comment status -> wp:comment_approved, the form the mapping reads. */
const REST_COMMENT_STATUS: Record<string, string> = { approved: "1", approve: "1", hold: "0", unapproved: "0", spam: "spam", trash: "trash" };

/** A REST comment -> the shape the mapping reads. Its post is named by id (comments are read site-wide). */
export function restCommentToComment(row: Record<string, unknown>): WpComment {
  const status = typeof row.status === "string" ? row.status : "approved";
  const type = typeof row.type === "string" ? row.type : "comment";
  return {
    id: row.id != null ? String(row.id) : "",
    postId: row.post != null ? String(row.post) : "",
    parentId: typeof row.parent === "number" && row.parent > 0 ? String(row.parent) : null,
    author: typeof row.author_name === "string" ? row.author_name : "",
    // The public API never gives it; with edit access it may.
    authorEmail: str(row.author_email),
    dateGmt: restDate(row.date_gmt),
    date: restDate(row.date),
    content: text(row.content),
    approved: REST_COMMENT_STATUS[status] ?? status,
    type: type === "comment" ? "" : type,
  };
}

/** A REST post (with _embed) -> the shape the mapping reads. Yoast's computed head fills the SEO meta. */
export function restPostToItem(post: Record<string, unknown>, terms: Map<number, WpTerm>, ctx: WpContext): WpItem {
  const embedded = (post._embedded ?? {}) as Record<string, unknown>;
  const author = Array.isArray(embedded.author) ? (embedded.author[0] as Record<string, unknown> | undefined) : undefined;
  if (author && typeof author.slug === "string" && !ctx.authors.some((a) => a.login === author.slug)) {
    ctx.authors.push({ id: author.id != null ? String(author.id) : null, login: author.slug, displayName: str(author.name), firstName: null, lastName: null });
  }
  const media = Array.isArray(embedded["wp:featuredmedia"]) ? (embedded["wp:featuredmedia"][0] as Record<string, unknown> | undefined) : undefined;
  const meta: Record<string, string> = {};

  // The featured image becomes an attachment in the context, so the mapping finds it by id.
  const mediaId = typeof post.featured_media === "number" && post.featured_media > 0 ? String(post.featured_media) : null;
  if (mediaId && media && typeof media.source_url === "string") {
    if (!ctx.attachments.some(([id]) => id === mediaId)) {
      ctx.attachments.push([mediaId, { url: media.source_url, alt: str(media.alt_text) }]);
    }
    meta["_thumbnail_id"] = mediaId;
  }

  // Yoast's computed head: kept where it says something the page does not already say.
  const head = (post.yoast_head_json ?? null) as Record<string, unknown> | null;
  if (head) {
    const title = str(head.title);
    const description = str(head.description);
    if (title) meta["_yoast_wpseo_title"] = title;
    if (description) meta["_yoast_wpseo_metadesc"] = description;
    if (str(head.canonical)) meta["_yoast_wpseo_canonical"] = String(head.canonical);
    const robots = (head.robots ?? {}) as Record<string, unknown>;
    if (robots.index === "noindex") meta["_yoast_wpseo_meta-robots-noindex"] = "1";
    const ogTitle = str(head.og_title);
    if (ogTitle && ogTitle !== title) meta["_yoast_wpseo_opengraph-title"] = ogTitle;
    const ogDesc = str(head.og_description);
    if (ogDesc && ogDesc !== description) meta["_yoast_wpseo_opengraph-description"] = ogDesc;
    const ogImage = Array.isArray(head.og_image) ? str((head.og_image[0] as Record<string, unknown> | undefined)?.url) : null;
    if (ogImage) meta["_yoast_wpseo_opengraph-image"] = ogImage;
  }

  const ids = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : []);
  const content = (post.content ?? {}) as Record<string, unknown>;
  const rendered = text(post.content);
  const isProtected = content.protected === true;
  const raw = typeof content.raw === "string" ? content.raw : null;
  return {
    id: String(post.id ?? ""),
    type: typeof post.type === "string" ? post.type : "post",
    status: typeof post.status === "string" ? post.status : "publish",
    title: text(post.title),
    slug: typeof post.slug === "string" ? post.slug : "",
    link: str(post.link),
    guid: str(text(post.guid)),
    // A protected post's rendered content is withheld; with edit access its raw content is not.
    content: isProtected && !rendered && raw ? raw : rendered,
    ...(isProtected && !rendered && raw ? { contentIsRaw: true } : {}),
    excerpt: text(post.excerpt),
    dateGmt: restDate(post.date_gmt),
    modifiedGmt: restDate(post.modified_gmt),
    date: restDate(post.date),
    password: isProtected || str(post.password) ? "protected" : null,
    creator: author && typeof author.slug === "string" ? author.slug : post.author ? `user-${String(post.author)}` : null,
    categories: ids(post.categories).map((id) => terms.get(id)?.slug).filter((s): s is string => Boolean(s)),
    tags: ids(post.tags).map((id) => terms.get(id + 1e9)?.slug).filter((s): s is string => Boolean(s)),
    meta,
    attachmentUrl: null,
    parentId: null,
    // Yoast's head is already computed: its values are text, never templates.
    seoResolved: true,
  };
}

/** The first step: checks the address and the credentials, and stages nothing yet. */
export async function probeSite(site: WordPressSite, fetcher: Fetcher): Promise<{ ok: true; state: PullState; name: string | null } | { ok: false; error: string }> {
  const root = restBase(site.url);
  if ("error" in root) return { ok: false, error: root.error };
  const authed = Boolean(site.username && site.applicationPassword);
  try {
    const info = await getJson(fetcher, `${root.base}/wp-json/`, site);
    const name = str((info.data as Record<string, unknown> | null)?.name);
    if (authed) await getJson(fetcher, `${root.base}/wp-json/wp/v2/users/me?context=edit`, site);
    return { ok: true, name, state: { base: root.base, authed, requests: authed ? 2 : 1, cursor: { phase: "categories", page: 1, totalPages: null, pending: [] } } };
  } catch (err) {
    return { ok: false, error: err instanceof PullError ? err.message : `Could not reach the WordPress site (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/**
 * One step of the pull: up to `maxRequests` GETs, the cursor recorded in `store` after each page.
 * Terms go into the context (categories with their parents and descriptions), posts into staged
 * pages. When done, the stage state is written, ready for convertStaged.
 */
export async function pullStep(
  site: WordPressSite,
  state: PullState,
  store: StageStore,
  fetcher: Fetcher,
  maxRequests: number,
): Promise<{ state: PullState; done: boolean }> {
  const ctx: WpContext = JSON.parse((await store.get(CTX)) ?? "null") ?? { ...emptyContext(), site: { title: null, link: state.base, baseSiteUrl: state.base, baseBlogUrl: state.base } };
  const termIndex = new Map<number, WpTerm>();
  for (const t of ctx.terms) if (t.id) termIndex.set(t.kind === "post_tag" ? Number(t.id) + 1e9 : Number(t.id), t);
  const stage: StageState = JSON.parse((await store.get(STATE)) ?? "null") ?? { source: "wordpress-rest", pages: 0, converted: 0, posts: 0, bytes: 0, xmlProblems: 0, firstXmlProblem: null };
  const c = state.cursor;
  const statuses = state.authed ? "&status=publish,future,draft,pending,private&context=edit" : "";
  let made = 0;

  const flush = async (force: boolean) => {
    while (c.pending.length >= PAGE_POSTS_STAGED || (force && c.pending.length)) {
      await store.put(inKey(stage.pages), JSON.stringify(c.pending.splice(0, PAGE_POSTS_STAGED)));
      stage.pages += 1;
    }
  };

  while (c.phase !== "done" && made < maxRequests) {
    if (c.phase === "categories" || c.phase === "tags") {
      const kind = c.phase === "categories" ? "categories" : "tags";
      const res = await getJson(fetcher, `${state.base}/wp-json/wp/v2/${kind}?per_page=${PER_PAGE}&page=${c.page}&hide_empty=true`, site);
      made += 1;
      const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const term: WpTerm = {
          kind: kind === "categories" ? "category" : "post_tag",
          id: String(row.id),
          slug: String(row.slug ?? ""),
          name: String(row.name ?? row.slug ?? ""),
          description: str(row.description),
          parent: null,
        };
        if (kind === "categories" && typeof row.parent === "number" && row.parent > 0) term.parent = `#${row.parent}`;
        if (term.slug) {
          ctx.terms.push(term);
          termIndex.set(kind === "tags" ? Number(row.id) + 1e9 : Number(row.id), term);
        }
      }
      if (res.totalPages === null || c.page >= res.totalPages || rows.length === 0) {
        if (kind === "categories") {
          // Parents were known only by id until every category was read.
          for (const t of ctx.terms) if (t.parent?.startsWith("#")) t.parent = termIndex.get(Number(t.parent.slice(1)))?.slug ?? null;
          c.phase = "tags";
        } else {
          c.phase = "posts";
        }
        c.page = 1;
      } else {
        c.page += 1;
      }
    } else if (c.phase === "posts") {
      const res = await getJson(fetcher, `${state.base}/wp-json/wp/v2/posts?per_page=${PER_PAGE}&page=${c.page}&_embed=author,wp:featuredmedia${statuses}&orderby=id&order=asc`, site);
      made += 1;
      const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const item = restPostToItem(row, termIndex, ctx);
        c.pending.push(item);
        stage.posts += 1;
        stage.bytes += item.content.length;
      }
      await flush(false);
      if (res.totalPages === null || c.page >= res.totalPages || rows.length === 0) {
        c.phase = "pages";
        c.page = 1;
      } else {
        c.page += 1;
      }
    } else if (c.phase === "pages") {
      // 0130: pages come across as Writavo pages, read like the posts.
      const res = await getJson(fetcher, `${state.base}/wp-json/wp/v2/pages?per_page=${PER_PAGE}&page=${c.page}&_embed=author,wp:featuredmedia${statuses}&orderby=id&order=asc`, site);
      made += 1;
      const rows = Array.isArray(res.data) ? (res.data as Array<Record<string, unknown>>) : [];
      for (const row of rows) {
        const item = restPostToItem({ ...row, type: "page" }, termIndex, ctx);
        c.pending.push(item);
        stage.posts += 1;
        stage.bytes += item.content.length;
      }
      await flush(false);
      if (res.totalPages === null || c.page >= res.totalPages || rows.length === 0) {
        c.phase = "comments";
        c.page = 1;
      } else {
        c.page += 1;
      }
    } else if (c.phase === "comments") {
      // Never a reason to fail the pull: a site that does not share its comments gets a note.
      const url = `${state.base}/wp-json/wp/v2/comments?per_page=${PER_PAGE}&page=${c.page}&orderby=id&order=asc`;
      made += 1;
      let rows: Array<Record<string, unknown>> | null = null;
      let totalPages: number | null = null;
      const notRead = (why: string) =>
        `${(stage.commentPages ?? 0) > 0 ? "Not every comment was read" : "Comments were not read"}: ${why}. Everything else is imported; to bring the comments too, import an export file (Tools > Export) instead.`;
      try {
        const res = await fetcher(url, { headers: headers(site) });
        const json = (res.headers.get("content-type") ?? "").includes("json");
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          stage.commentsNote = notRead(`this site's REST API does not share them (WordPress answered ${res.status})`);
        } else if (!res.ok || !json) {
          stage.commentsNote = notRead(`WordPress answered ${res.ok ? "with a web page, not JSON" : res.status} for its comments`);
        } else {
          const data = (await res.json()) as unknown;
          rows = Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [];
          const tp = Number(res.headers.get("x-wp-totalpages"));
          totalPages = Number.isFinite(tp) && tp > 0 ? tp : null;
        }
      } catch (err) {
        stage.commentsNote = notRead(`the site did not answer (${err instanceof Error ? err.message : String(err)})`);
      }
      if (rows === null) {
        c.phase = "done";
      } else {
        if (rows.length) {
          const n = stage.commentPages ?? 0;
          await store.put(commentsKey(n), JSON.stringify(rows.map(restCommentToComment)));
          stage.commentPages = n + 1;
        }
        if (totalPages === null || c.page >= totalPages || rows.length === 0) c.phase = "done";
        else c.page += 1;
      }
    }
  }
  state.requests += made;
  if (c.phase === "done") await flush(true);
  if (!ctx.site.title) {
    ctx.site.title = null;
  }
  await store.put(CTX, JSON.stringify(ctx));
  await store.put(STATE, JSON.stringify(stage));
  return { state, done: c.phase === "done" };
}


/** The site's name from the probe, recorded in the context. */
export async function setSiteName(store: StageStore, base: string, name: string | null): Promise<void> {
  const ctx: WpContext = { ...emptyContext(), site: { title: name, link: base, baseSiteUrl: base, baseBlogUrl: base } };
  await store.put(CTX, JSON.stringify(ctx));
}

export { addToContext };
