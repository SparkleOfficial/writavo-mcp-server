import { SaxesParser, type SaxesTagPlain } from "saxes";
import { emptyExport, KEPT_META, type WpAuthor, type WpComment, type WpExport, type WpItem, type WpSite, type WpTerm } from "./model.js";

/**
 * A streaming reader for WXR, the file WordPress writes at Tools > Export (WXR 1.1 and 1.2).
 *
 * STREAMING, because the file can be far larger than what the importer keeps: it is fed in chunks
 * (write) and hands back one record per author, term and item as each one closes, so the raw XML is
 * never held whole. What is read is the minimum the mapping uses; an author's email address,
 * comment meta, menus and every post meta key outside KEPT_META are skipped as they stream past.
 * A post's comments are read into the item (wp:comment), for the comments import (0160).
 *
 * Pure JavaScript (saxes), no DOM: the same code runs in the hosted Durable Object, Node and tests.
 */

export type WxrRecord =
  | { kind: "site"; site: WpSite }
  | { kind: "author"; author: WpAuthor }
  | { kind: "term"; term: WpTerm }
  | { kind: "item"; item: WpItem };

/** How many XML problems are reported before the rest are only counted. */
const MAX_REPORTED_ERRORS = 5;

function newItem(): WpItem {
  return {
    id: "",
    type: "",
    status: "",
    title: "",
    slug: "",
    link: null,
    guid: null,
    content: "",
    excerpt: "",
    dateGmt: null,
    modifiedGmt: null,
    date: null,
    password: null,
    creator: null,
    categories: [],
    tags: [],
    meta: {},
    attachmentUrl: null,
    parentId: null,
  };
}

const orNull = (s: string): string | null => {
  const t = s.trim();
  return t ? t : null;
};

export class WxrReader {
  private readonly parser = new SaxesParser({ xmlns: false });
  private readonly stack: string[] = [];
  private text = "";
  private site: WpSite = { title: null, link: null, baseSiteUrl: null, baseBlogUrl: null };
  private siteSent = false;
  private item: WpItem | null = null;
  private author: WpAuthor | null = null;
  private term: WpTerm | null = null;
  private meta: { key: string; value: string } | null = null;
  private category: { domain: string; nicename: string } | null = null;
  /** The <wp:comment> being read, inside an item. */
  private comment: WpComment | null = null;
  /** Inside something that is never read (a comment's meta, a comment outside an item). */
  private commentDepth = 0;
  /** A WXR marker was seen (the wp:wxr_version element). */
  sawWxr = false;
  sawRss = false;
  readonly errors: string[] = [];
  errorCount = 0;

  constructor(private readonly onRecord: (record: WxrRecord) => void) {
    this.parser.on("opentag", (tag) => this.open(tag));
    this.parser.on("closetag", (tag) => this.close(tag.name));
    this.parser.on("text", (t) => {
      if (this.commentDepth === 0) this.text += t;
    });
    this.parser.on("cdata", (t) => {
      if (this.commentDepth === 0) this.text += t;
    });
    // Keep going after a problem (an exporter's stray control character must not lose the whole
    // blog); each one is reported, and the mapping checks what came out.
    this.parser.on("error", (err) => {
      this.errorCount += 1;
      if (this.errors.length < MAX_REPORTED_ERRORS) this.errors.push(err.message);
    });
  }

  write(chunk: string): void {
    this.parser.write(chunk);
  }

  end(): void {
    this.parser.close();
    this.sendSite();
  }

  private sendSite(): void {
    if (this.siteSent) return;
    this.siteSent = true;
    this.onRecord({ kind: "site", site: this.site });
  }

  private open(tag: SaxesTagPlain): void {
    const name = tag.name;
    const parent = this.stack[this.stack.length - 1];
    this.stack.push(name);
    this.text = "";
    if (this.commentDepth > 0) {
      this.commentDepth += 1;
      return;
    }
    if (name === "wp:comment") {
      if (parent === "item" && this.item) {
        this.comment = { id: "", parentId: null, author: "", authorEmail: null, dateGmt: null, date: null, content: "", approved: "", type: "" };
      } else {
        this.commentDepth = 1;
      }
      return;
    }
    if (this.comment && parent === "wp:comment" && name === "wp:commentmeta") {
      this.commentDepth = 1;
      return;
    }
    if (name === "rss") this.sawRss = true;
    if (parent === "channel") {
      if (name === "item") {
        this.sendSite();
        this.item = newItem();
      } else if (name === "wp:author") {
        this.author = { id: null, login: "", displayName: null, firstName: null, lastName: null };
      } else if (name === "wp:category") {
        this.term = { kind: "category", id: null, slug: "", name: "", description: null, parent: null };
      } else if (name === "wp:tag") {
        this.term = { kind: "post_tag", id: null, slug: "", name: "", description: null, parent: null };
      }
    } else if (parent === "item" && this.item) {
      if (name === "category") {
        const attrs = tag.attributes as Record<string, string>;
        this.category = { domain: attrs.domain ?? "", nicename: attrs.nicename ?? "" };
      } else if (name === "wp:postmeta") {
        this.meta = { key: "", value: "" };
      }
    }
  }

  private close(name: string): void {
    this.stack.pop();
    const parent = this.stack[this.stack.length - 1];
    const text = this.text;
    this.text = "";
    if (this.commentDepth > 0) {
      this.commentDepth -= 1;
      return;
    }

    if (this.comment) {
      if (name === "wp:comment" && parent === "item") {
        if (this.item) (this.item.comments ??= []).push(this.comment);
        this.comment = null;
      } else if (parent === "wp:comment") {
        const c = this.comment;
        if (name === "wp:comment_id") c.id = text.trim();
        else if (name === "wp:comment_author") c.author = text;
        else if (name === "wp:comment_author_email") c.authorEmail = orNull(text);
        else if (name === "wp:comment_date_gmt") c.dateGmt = orNull(text);
        else if (name === "wp:comment_date") c.date = orNull(text);
        else if (name === "wp:comment_content") c.content = text;
        else if (name === "wp:comment_approved") c.approved = text.trim();
        else if (name === "wp:comment_type") c.type = text.trim();
        else if (name === "wp:comment_parent") c.parentId = orNull(text) === "0" ? null : orNull(text);
        // wp:comment_user_id is not read: a WordPress account does not make a commenter staff.
      }
      return;
    }

    if (parent === "channel") {
      switch (name) {
        case "title":
          this.site.title = orNull(text);
          return;
        case "link":
          this.site.link = orNull(text);
          return;
        case "wp:base_site_url":
          this.site.baseSiteUrl = orNull(text);
          return;
        case "wp:base_blog_url":
          this.site.baseBlogUrl = orNull(text);
          return;
        case "wp:wxr_version":
          this.sawWxr = true;
          return;
        case "item":
          if (this.item) this.onRecord({ kind: "item", item: this.item });
          this.item = null;
          return;
        case "wp:author":
          if (this.author?.login) this.onRecord({ kind: "author", author: this.author });
          this.author = null;
          return;
        case "wp:category":
        case "wp:tag":
          if (this.term?.slug) this.onRecord({ kind: "term", term: this.term });
          this.term = null;
          return;
      }
      return;
    }

    if (parent === "wp:author" && this.author) {
      // wp:author_email is deliberately never read.
      if (name === "wp:author_id") this.author.id = orNull(text);
      else if (name === "wp:author_login") this.author.login = text.trim();
      else if (name === "wp:author_display_name") this.author.displayName = orNull(text);
      else if (name === "wp:author_first_name") this.author.firstName = orNull(text);
      else if (name === "wp:author_last_name") this.author.lastName = orNull(text);
      return;
    }

    if ((parent === "wp:category" || parent === "wp:tag") && this.term) {
      if (name === "wp:term_id") this.term.id = orNull(text);
      else if (name === "wp:category_nicename" || name === "wp:tag_slug") this.term.slug = text.trim();
      else if (name === "wp:category_parent") this.term.parent = orNull(text);
      else if (name === "wp:cat_name" || name === "wp:tag_name") this.term.name = text.trim();
      else if (name === "wp:category_description" || name === "wp:tag_description") this.term.description = orNull(text);
      return;
    }

    if (parent === "wp:postmeta" && this.meta) {
      if (name === "wp:meta_key") this.meta.key = text.trim();
      else if (name === "wp:meta_value") this.meta.value = text;
      return;
    }

    if (parent === "item" && this.item) {
      const item = this.item;
      switch (name) {
        case "title":
          item.title = text;
          return;
        case "link":
          item.link = orNull(text);
          return;
        case "guid":
          item.guid = orNull(text);
          return;
        case "content:encoded":
          item.content = text;
          return;
        case "excerpt:encoded":
          item.excerpt = text;
          return;
        case "dc:creator":
          item.creator = orNull(text);
          return;
        case "wp:post_id":
          item.id = text.trim();
          return;
        case "wp:post_date":
          item.date = orNull(text);
          return;
        case "wp:post_date_gmt":
          item.dateGmt = orNull(text);
          return;
        case "wp:post_modified_gmt":
          item.modifiedGmt = orNull(text);
          return;
        case "wp:post_name":
          item.slug = text.trim();
          return;
        case "wp:status":
          item.status = text.trim();
          return;
        case "wp:post_type":
          item.type = text.trim();
          return;
        case "wp:post_password":
          item.password = orNull(text);
          return;
        case "wp:post_parent":
          item.parentId = orNull(text);
          return;
        case "wp:attachment_url":
          item.attachmentUrl = orNull(text);
          return;
        case "category":
          if (this.category) {
            const slug = this.category.nicename.trim();
            if (slug && this.category.domain === "category") item.categories.push(slug);
            else if (slug && this.category.domain === "post_tag") item.tags.push(slug);
          }
          this.category = null;
          return;
        case "wp:postmeta":
          if (this.meta && KEPT_META.has(this.meta.key)) item.meta[this.meta.key] = this.meta.value;
          this.meta = null;
          return;
      }
    }
  }
}

/** Does this text look like a WXR file? Checked on the first few kilobytes. */
export function looksLikeWxr(head: string): boolean {
  const start = head.slice(0, 8192);
  return /<rss[\s>]/.test(start) && /xmlns:wp\s*=\s*["']http:\/\/wordpress\.org\/export\//.test(start);
}

/** The whole export, read from text (tests and small files). The streaming path uses WxrReader. */
export function readWxr(text: string): WpExport & { errors: string[]; errorCount: number; isWxr: boolean } {
  const out = emptyExport();
  const reader = new WxrReader((r) => collect(out, r));
  // Chunks, as the streaming path feeds it, so the tests exercise the same code.
  for (let i = 0; i < text.length; i += 65_536) reader.write(text.slice(i, i + 65_536));
  reader.end();
  return { ...out, errors: reader.errors, errorCount: reader.errorCount, isWxr: reader.sawRss && reader.sawWxr };
}

export function collect(out: WpExport, record: WxrRecord): void {
  switch (record.kind) {
    case "site":
      out.site = record.site;
      return;
    case "author":
      out.authors.push(record.author);
      return;
    case "term":
      out.terms.push(record.term);
      return;
    case "item":
      out.items.push(record.item);
      return;
  }
}
