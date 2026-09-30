import type { Element, ElementContent, Nodes as HastNodes, Root as HastRoot } from "hast";
import type { Nodes as MdastNodes, Paragraph, PhrasingContent, Root as MdastRoot, RootContent } from "mdast";
import { fromHtml } from "hast-util-from-html";
import { defaultHandlers, toMdast, type State } from "hast-util-to-mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown, gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown, type Handle as MdHandle } from "mdast-util-to-markdown";
import { toString as mdastToString } from "mdast-util-to-string";
import { gfm } from "micromark-extension-gfm";
import { wpautop } from "./autop.js";
import { EMBED_LINE, embedLine, embedUrl, parseEmbedUrl } from "./embeds.js";
import { expandShortcodes, type Attachment } from "./shortcodes.js";

/**
 * WordPress post HTML -> Writavo markdown, with the words unchanged.
 *
 * One pipeline for both sources: a WXR file's RAW content (the classic editor's blank-line
 * paragraphs, shortcodes unexpanded) goes through the shortcode expansion and wpautop first; the
 * REST API's rendered content is already HTML. Then hast (parse5, no DOM) -> mdast -> markdown,
 * with WordPress-aware handlers:
 *   - images: the ORIGINAL upload (via the wp-image-<id> class and the export's attachments), else
 *     the largest srcset candidate, else src, so the import copies the full-size file;
 *   - a caption becomes an italic line under its image (visible, as it was);
 *   - YouTube / Vimeo / X (iframes, embed blocks, [embed], a URL alone on its line) become an
 *     ::embed line; any other embedded frame becomes a link, reported;
 *   - video and audio become links, reported (the media library takes images only);
 *   - scripts, forms and plugin widgets are dropped, reported.
 *
 * THE WORDS CHECK. After converting, the text a reader sees is compared, whitespace aside, between
 * the source HTML and the markdown (parsed back). A difference is reported on the article: the
 * conversion changes the format, never the words, and a silent change would be the worst outcome.
 */

export interface HtmlContext {
  /** WXR raw content (shortcodes + wpautop first). false for already-rendered HTML (REST). */
  raw: boolean;
  attachments: Map<string, Attachment>;
  attachmentsByParent: Map<string, string[]>;
  postId: string;
  /** The old site's home URL, to make relative image URLs absolute. */
  siteUrl: string | null;
}

export interface Converted {
  markdown: string;
  warnings: string[];
  /** Shortcode names left as written. */
  unknownShortcodes: string[];
  /** The words check failed (the warning says where). */
  wordsChanged: boolean;
}

// ---- helpers over hast ------------------------------------------------------------------------

const classes = (el: Element): string[] => {
  const c = el.properties?.className;
  return Array.isArray(c) ? c.map(String) : typeof c === "string" ? c.split(/\s+/) : [];
};
const prop = (el: Element, name: string): string | null => {
  const v = el.properties?.[name];
  return typeof v === "string" && v.trim() ? v.trim() : Array.isArray(v) ? v.join(" ") : null;
};

/** Elements whose content never reaches the page as words. */
const DROPPED = new Set(["script", "style", "noscript", "template", "form", "button", "input", "select", "textarea", "object", "embed", "svg", "canvas"]);
const REPORTED_DROPS = new Set(["script", "form", "object", "embed", "canvas"]);

function walk(node: HastNodes, visit: (el: Element) => void): void {
  if (node.type === "element") visit(node);
  if ("children" in node) for (const child of node.children) walk(child as HastNodes, visit);
}

function textOf(node: HastNodes): string {
  if (node.type === "text") return node.value;
  if (!("children" in node)) return "";
  return node.children.map((c) => textOf(c as HastNodes)).join("");
}

function firstDescendant(node: HastNodes, test: (el: Element) => boolean): Element | null {
  let found: Element | null = null;
  walk(node, (el) => {
    if (!found && test(el)) found = el;
  });
  return found;
}

/** The URL an embed block, frame or tweet quote names, or null. */
function embeddedUrl(el: Element): string | null {
  if (el.tagName === "wv-embed") return prop(el, "dataUrl");
  if (el.tagName === "iframe") return prop(el, "src") ?? prop(el, "dataSrc");
  if (el.tagName === "figure" && classes(el).some((c) => c === "wp-block-embed" || c.startsWith("wp-block-embed-"))) {
    const frame = firstDescendant(el, (d) => d.tagName === "iframe");
    if (frame) return prop(frame, "src");
    const wrapper = firstDescendant(el, (d) => classes(d).includes("wp-block-embed__wrapper"));
    const text = textOf(wrapper ?? el).trim();
    return /^https?:\/\/\S+$/.test(text) ? text : null;
  }
  if (el.tagName === "blockquote" && classes(el).includes("twitter-tweet")) {
    let url: string | null = null;
    walk(el, (a) => {
      const href = a.tagName === "a" ? prop(a, "href") : null;
      if (href && /\/status\/\d+/.test(href)) url = href;
    });
    return url;
  }
  return null;
}

const isEmbedBlock = (el: Element) =>
  el.tagName === "wv-embed" ||
  (el.tagName === "figure" && classes(el).some((c) => c === "wp-block-embed" || c.startsWith("wp-block-embed-")));

/** The image to copy: the original upload when the export knows it, else the largest srcset. */
function imageUrl(el: Element, ctx: HtmlContext): string | null {
  const idClass = classes(el).find((c) => /^wp-image-\d+$/.test(c));
  const original = idClass ? ctx.attachments.get(idClass.slice("wp-image-".length))?.url : undefined;
  if (original) return original;
  const srcset = prop(el, "srcSet") ?? prop(el, "dataSrcset");
  if (srcset) {
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(",")) {
      const [url, size] = part.trim().split(/\s+/);
      const w = size && size.endsWith("w") ? Number(size.slice(0, -1)) : 0;
      if (url && (!best || w > best.w)) best = { url, w };
    }
    if (best) return best.url;
  }
  const src = prop(el, "src");
  const lazy = prop(el, "dataSrc") ?? prop(el, "dataLazySrc") ?? prop(el, "dataOrigFile");
  // A lazy-loading plugin leaves a placeholder (a data: URI or a tiny gif) in src.
  if (lazy && (!src || src.startsWith("data:"))) return lazy;
  return src && !src.startsWith("data:") ? src : lazy;
}

function absolute(url: string, base: string | null): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return `https:${url}`;
  try {
    return base ? new URL(url, base).toString() : url;
  } catch {
    return url;
  }
}

// ---- the custom mdast node for an embed -------------------------------------------------------

interface WvEmbed {
  type: "wvEmbed";
  url: string;
}
const embedNode = (url: string) => ({ type: "wvEmbed", url: embedUrl(url) }) as unknown as MdastNodes;
const linkParagraph = (url: string): Paragraph => ({
  type: "paragraph",
  children: [{ type: "link", url, children: [{ type: "text", value: url }] }],
});

const blank = (c: { type: string; value?: string }) => c.type === "break" || (c.type === "text" && !(c.value ?? "").trim());

/**
 * A line break at the very start or end of a paragraph (wpautop leaves them around removed
 * markup) would serialise as a stray backslash; a paragraph of nothing but breaks is dropped.
 */
function tidyParagraphs(parent: { children: unknown[] }): void {
  const kept: unknown[] = [];
  for (const child of parent.children as Array<{ type: string; children?: Array<{ type: string; value?: string }> }>) {
    if ((child.type === "paragraph" || child.type === "heading") && child.children) {
      const kids = child.children;
      while (kids.length && kids[0]!.type === "break") kids.shift();
      while (kids.length && (kids[kids.length - 1]!.type === "break" || (kids[kids.length - 1]!.type === "text" && !kids[kids.length - 1]!.value!.trim() && kids.length > 1 && kids[kids.length - 2]!.type === "break"))) kids.pop();
      if (child.type === "paragraph" && kids.every(blank)) continue;
    } else if (child.children) {
      tidyParagraphs(child as { children: unknown[] });
    }
    kept.push(child);
  }
  parent.children = kept;
}

/** Lift every embed out of the paragraph it sits in, so it becomes a line of its own. */
function liftEmbeds(parent: { children: unknown[] }): void {
  const out: unknown[] = [];
  for (const child of parent.children as Array<{ type: string; children?: unknown[] }>) {
    if (child.type === "paragraph" && child.children?.some((c) => (c as { type: string }).type === "wvEmbed")) {
      let run: PhrasingContent[] = [];
      const flush = () => {
        if (!run.every(blank)) out.push({ type: "paragraph", children: run });
        run = [];
      };
      for (const c of child.children as Array<PhrasingContent | WvEmbed>) {
        if (c.type === "wvEmbed") {
          flush();
          out.push(c);
        } else {
          run.push(c as PhrasingContent);
        }
      }
      flush();
      continue;
    }
    if (child.children && child.type !== "paragraph") liftEmbeds(child as { children: unknown[] });
    out.push(child);
  }
  parent.children = out;
}

// ---- the words check --------------------------------------------------------------------------

/** What the converted markdown should read as, derived from the HTML by the same decisions. */
function expectedText(node: HastNodes, ctx: HtmlContext): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "children" in node ? node.children.map((c) => expectedText(c as HastNodes, ctx)).join("") : "";
  const el = node;
  if (DROPPED.has(el.tagName) || el.tagName === "img" || el.tagName === "br") return "";
  if (el.tagName === "blockquote" && classes(el).includes("twitter-tweet")) return el.children.map((c) => expectedText(c as HastNodes, ctx)).join("");
  if (el.tagName === "iframe" || isEmbedBlock(el)) {
    const url = embeddedUrl(el);
    return url && !parseEmbedUrl(url) ? url : "";
  }
  if (el.tagName === "video" || el.tagName === "audio") return mediaSrc(el) ?? "";
  return el.children.map((c) => expectedText(c as HastNodes, ctx)).join("");
}

function actualText(markdown: string): string {
  const withoutEmbeds = markdown
    .split("\n")
    .filter((line) => !EMBED_LINE.test(line.trim()))
    .join("\n");
  const tree = fromMarkdown(withoutEmbeds, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  return mdastToString(tree, { includeImageAlt: false, includeHtml: false });
}

const squash = (s: string) => s.normalize("NFC").replace(/[\s\u200b\u200c\u200d\ufeff]+/g, "");

function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const around = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 30));
  return `source ${around(a)}, imported ${around(b)}`;
}

function mediaSrc(el: Element): string | null {
  const own = prop(el, "src");
  if (own) return own;
  const source = firstDescendant(el, (d) => d.tagName === "source");
  return source ? prop(source, "src") : null;
}

// ---- the conversion ---------------------------------------------------------------------------

/** Block-editor content (has_blocks): WordPress does not run wpautop on it. */
const hasBlocks = (html: string) => html.includes("<!-- wp:");

export function wordpressHtmlToMarkdown(input: string, ctx: HtmlContext): Converted {
  const warnings: string[] = [];
  let html = input;
  let unknownShortcodes: string[] = [];

  if (ctx.raw) {
    // A dynamic block (latest posts, a form plugin's block) is rendered by WordPress at view time
    // and saves no HTML: there is nothing to carry over, so say so.
    const dynamic = new Set<string>();
    for (const m of html.matchAll(/<!--\s+wp:([a-z0-9/-]+)(?:\s[^>]*?)?\s*\/-->/g)) dynamic.add(m[1]!);
    dynamic.delete("more");
    dynamic.delete("nextpage");
    if (dynamic.size) warnings.push(`blocks rendered by WordPress at view time have no saved content and are left out: ${[...dynamic].join(", ")}`);
    const shortcodes = expandShortcodes(html, ctx);
    html = shortcodes.html;
    warnings.push(...shortcodes.warnings);
    unknownShortcodes = shortcodes.unknown;
    if (!hasBlocks(html)) html = wpautop(html);
  }

  const hast = fromHtml(html, { fragment: true }) as HastRoot;

  const drops = new Set<string>();
  let spanned = false;
  let lostFrames = 0;
  walk(hast, (el) => {
    if (REPORTED_DROPS.has(el.tagName)) drops.add(el.tagName);
    if ((el.tagName === "td" || el.tagName === "th") && (Number(el.properties?.colSpan ?? 1) > 1 || Number(el.properties?.rowSpan ?? 1) > 1)) spanned = true;
  });

  const handlers: Record<string, (state: State, el: Element, parent: unknown) => MdastNodes | MdastNodes[] | undefined> = {
    img(state, el) {
      const url = imageUrl(el, ctx);
      if (!url) return undefined;
      const image = { type: "image" as const, url: absolute(url, ctx.siteUrl), alt: prop(el, "alt") ?? "", title: prop(el, "title") };
      state.patch(el, image);
      return image;
    },
    // A link the old CMS marked nofollow, sponsored or ugc keeps that choice. Writavo stores it in
    // the link's title as `rel:nofollow` (its one rule for whether a link is followed, the docs'
    // "Dofollow or nofollow"), so a migrated paid or swapped link does not silently become dofollow.
    a(state, el) {
      const node = (defaultHandlers.a as (s: State, e: Element) => MdastNodes)(state, el);
      const rel = el.properties?.rel;
      const tokens = (Array.isArray(rel) ? rel.map(String) : typeof rel === "string" ? rel.split(/\s+/) : []).map((t) => t.toLowerCase());
      const choice = tokens.includes("sponsored") ? "sponsored" : tokens.includes("ugc") ? "ugc" : tokens.includes("nofollow") ? "nofollow" : null;
      if (choice && node && (node as { type?: string }).type === "link") {
        const link = node as { title?: string | null };
        const title = (link.title ?? "").replace(/(^|\s)rel:(follow|nofollow|sponsored|ugc)(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
        link.title = title ? `${title} rel:${choice}` : `rel:${choice}`;
      }
      return node;
    },
    "wv-embed"(_state, el) {
      const url = prop(el, "dataUrl");
      return url ? embedNode(url) : undefined;
    },
    iframe(_state, el) {
      const url = embeddedUrl(el);
      if (!url) return undefined;
      if (parseEmbedUrl(url)) return embedNode(url);
      lostFrames += 1;
      return linkParagraph(absolute(url, ctx.siteUrl));
    },
    figure(state, el) {
      if (isEmbedBlock(el)) {
        const url = embeddedUrl(el);
        if (url && parseEmbedUrl(url)) return embedNode(url);
        if (url) {
          lostFrames += 1;
          return linkParagraph(url);
        }
        return state.toFlow(state.all(el));
      }
      return state.toFlow(state.all(el));
    },
    figcaption(state, el) {
      const children = state.all(el) as PhrasingContent[];
      if (!children.length) return undefined;
      return { type: "paragraph", children: [{ type: "emphasis", children }] };
    },
    blockquote(state, el) {
      const quote = (defaultHandlers.blockquote as (s: State, e: Element) => MdastNodes)(state, el);
      if (classes(el).includes("twitter-tweet")) {
        const url = embeddedUrl(el);
        if (url && parseEmbedUrl(url)) return [quote, embedNode(url)];
      }
      return quote;
    },
    video(_state, el) {
      const url = mediaSrc(el);
      if (!url) return undefined;
      if (parseEmbedUrl(url)) return embedNode(url);
      warnings.push("a video is kept as a link to its original URL (the media library takes images only)");
      return linkParagraph(absolute(url, ctx.siteUrl));
    },
    audio(_state, el) {
      const url = mediaSrc(el);
      if (!url) return undefined;
      warnings.push("an audio file is kept as a link to its original URL (the media library takes images only)");
      return linkParagraph(absolute(url, ctx.siteUrl));
    },
  };
  for (const tag of DROPPED) handlers[tag] = () => undefined;

  // Comments (the block editor's <!-- wp:... --> markers, <!--more-->) carry no words.
  const mdast = toMdast(hast, { handlers: handlers as never, nodeHandlers: { comment: () => undefined } }) as MdastRoot;
  liftEmbeds(mdast as unknown as { children: unknown[] });
  tidyParagraphs(mdast as unknown as { children: unknown[] });

  const markdown = toMarkdown(mdast, {
    extensions: [gfmToMarkdown()],
    handlers: { wvEmbed: ((node: WvEmbed) => embedLine(node.url)) as unknown as MdHandle } as Record<string, MdHandle>,
    bullet: "-",
    emphasis: "_",
    strong: "*",
    fences: true,
    rule: "-",
    listItemIndent: "one",
  }).trim();

  if (drops.size) warnings.push(`left out because they only work on the old site: ${[...drops].map((d) => `<${d}>`).join(", ")}`);
  if (lostFrames) warnings.push(`${lostFrames} embedded frame(s) from sites Writavo does not embed are kept as links`);
  if (spanned) warnings.push("a table with merged cells is flattened; check it");
  if (unknownShortcodes.length) warnings.push(`possible shortcodes left as written: ${unknownShortcodes.map((n) => `[${n}]`).join(", ")}`);

  const expected = squash(expectedText(hast, ctx));
  const actual = squash(actualText(markdown));
  const wordsChanged = expected !== actual;
  if (wordsChanged) warnings.push(`the text may have changed in conversion, so check this article (${firstDifference(expected, actual)})`);

  return { markdown, warnings, unknownShortcodes, wordsChanged };
}

/** Plain text from a fragment of HTML (titles, excerpts): entities decoded, tags gone. */
export function htmlToPlainText(html: string): string {
  if (!/[<&]/.test(html)) return html.replace(/\s+/g, " ").trim();
  return textOf(fromHtml(html, { fragment: true }) as HastRoot).replace(/\s+/g, " ").trim();
}

export type { ElementContent, RootContent };
