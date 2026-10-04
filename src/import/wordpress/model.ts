/**
 * The WordPress export as the converter sees it: one shape, whichever way it was read (a WXR file
 * today, the REST API next). Only what the mapping uses is kept; everything else in an export
 * (menus, comment meta, the email addresses of authors) is dropped while reading, never held.
 * Readers' comments are kept (0160): a migrated blog keeps its conversations, and a commenter's
 * email address goes to the Site's moderators only, as it was on the old blog.
 */

export interface WpSite {
  title: string | null;
  /** The site's home URL (<link>), e.g. https://example.com */
  link: string | null;
  /** wp:base_site_url / wp:base_blog_url: where WordPress itself lives. */
  baseSiteUrl: string | null;
  baseBlogUrl: string | null;
}

/** An author. The email address is never read. */
export interface WpAuthor {
  id: string | null;
  login: string;
  displayName: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface WpTerm {
  kind: "category" | "post_tag";
  /** wp:term_id; Yoast and Rank Math name a post's primary category by it. */
  id: string | null;
  slug: string;
  name: string;
  description: string | null;
  /** The parent category's slug (categories only). */
  parent: string | null;
}

/** Only these post meta keys are kept; a site's other meta can be large and is never used. */
export const KEPT_META = new Set([
  "_thumbnail_id",
  "_wp_attachment_image_alt",
  "_yoast_wpseo_title",
  "_yoast_wpseo_metadesc",
  "_yoast_wpseo_canonical",
  "_yoast_wpseo_meta-robots-noindex",
  "_yoast_wpseo_opengraph-title",
  "_yoast_wpseo_opengraph-description",
  "_yoast_wpseo_opengraph-image",
  "_yoast_wpseo_focuskw",
  "_yoast_wpseo_primary_category",
  "rank_math_title",
  "rank_math_description",
  "rank_math_canonical_url",
  "rank_math_robots",
  "rank_math_facebook_title",
  "rank_math_facebook_description",
  "rank_math_facebook_image",
  "rank_math_focus_keyword",
  "rank_math_primary_category",
]);

/** A reader comment (wp:comment in a WXR item, or a REST /comments row). */
export interface WpComment {
  /** wp:comment_id */
  id: string;
  /** REST only: the post it is on. A WXR comment sits inside its post. */
  postId?: string;
  /** wp:comment_parent; null (or "0") for a top-level comment. */
  parentId: string | null;
  author: string;
  authorEmail: string | null;
  /** "YYYY-MM-DD HH:MM:SS" in UTC, or null; `date` (site-local) when the GMT date is missing. */
  dateGmt: string | null;
  date: string | null;
  /** The comment as WordPress stored it (raw, light HTML) or rendered it (REST). */
  content: string;
  /** wp:comment_approved: "1", "0", "spam", "trash", "post-trashed"... (REST: always "1"). */
  approved: string;
  /** wp:comment_type: "" or "comment" for a comment; "pingback", "trackback" and others are not. */
  type: string;
}

export interface WpItem {
  id: string;
  /** post, page, attachment, nav_menu_item, a custom post type... */
  type: string;
  /** publish, future, draft, pending, private, trash, auto-draft, inherit */
  status: string;
  title: string;
  /** post_name, as stored (it may be percent-encoded). */
  slug: string;
  link: string | null;
  guid: string | null;
  /** content:encoded, RAW (no wpautop, shortcodes unexpanded) for a WXR file. */
  content: string;
  excerpt: string;
  /** "YYYY-MM-DD HH:MM:SS" in UTC; "0000-00-00 00:00:00" when WordPress never set it. */
  dateGmt: string | null;
  modifiedGmt: string | null;
  /** Site-local time, used only when the GMT date is missing. */
  date: string | null;
  password: string | null;
  /** dc:creator: the author's login. */
  creator: string | null;
  categories: string[];
  tags: string[];
  meta: Record<string, string>;
  /** Attachments only: the file's URL. */
  attachmentUrl: string | null;
  /** wp:post_parent: for an attachment, the post it was uploaded to. */
  parentId: string | null;
  /**
   * Whether `content` is raw (no wpautop, shortcodes unexpanded). Unset: the source's default (a
   * WXR file is raw, the REST API's rendered content is not). The REST API gives raw content only
   * for a password-protected post, whose rendered content it withholds.
   */
  contentIsRaw?: boolean;
  /** The SEO meta is final text (the REST API's computed head), not Yoast / Rank Math templates. */
  seoResolved?: boolean;
  /** Its readers' comments (WXR; the REST API's come site-wide, staged on their own). */
  comments?: WpComment[];
}

export interface WpExport {
  site: WpSite;
  authors: WpAuthor[];
  terms: WpTerm[];
  items: WpItem[];
}

export function emptyExport(): WpExport {
  return { site: { title: null, link: null, baseSiteUrl: null, baseBlogUrl: null }, authors: [], terms: [], items: [] };
}
