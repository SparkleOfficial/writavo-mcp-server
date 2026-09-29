import { parseEmbedUrl } from "./embeds.js";

/**
 * The WordPress shortcodes a blog post commonly carries, turned into plain HTML BEFORE the post is
 * converted, so the converter sees a figure, an image or an embed marker instead of bracket text.
 *
 * Handled: [caption] / [wp_caption] (an image with a caption), [embed] (a video or post URL),
 * [gallery] (the images it lists), [video] / [audio] (kept as a link: the media library takes
 * images only). Anything else that looks like a shortcode stays exactly as written and is reported,
 * because only the old site knew what it rendered.
 */

export interface ShortcodeResult {
  html: string;
  warnings: string[];
  /** Names of shortcodes left as written, e.g. ["contact-form-7", "su_button"]. */
  unknown: string[];
}

export interface Attachment {
  url: string;
  alt: string | null;
}

export interface ShortcodeContext {
  attachments: Map<string, Attachment>;
  /** Attachment ids by the post they were uploaded to, for a [gallery] without ids. */
  attachmentsByParent: Map<string, string[]>;
  postId: string;
}

const HANDLED = ["caption", "wp_caption", "embed", "gallery", "video", "audio", "playlist"];

/** WordPress's get_shortcode_regex(), without its possessive quantifiers (JavaScript has none). */
function shortcodeRegex(names: string[]): RegExp {
  const tags = names.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
  return new RegExp(
    `\\[(\\[?)(${tags})(?![\\w-])([^\\]\\/]*(?:\\/(?!\\])[^\\]\\/]*)*?)(?:(\\/)\\]|\\](?:([^\\[]*(?:\\[(?!\\/\\2\\])[^\\[]*)*)\\[\\/\\2\\])?)(\\]?)`,
    "g",
  );
}

/** WordPress's shortcode_parse_atts(). */
export function parseAtts(text: string): Record<string, string> {
  const atts: Record<string, string> = {};
  const re = /([\w-]+)\s*=\s*"([^"]*)"(?:\s|$)|([\w-]+)\s*=\s*'([^']*)'(?:\s|$)|([\w-]+)\s*=\s*([^\s'"]+)(?:\s|$)/g;
  const cleaned = text.replace(/[\u00a0\u200b]/g, " ");
  for (const m of cleaned.matchAll(re)) {
    if (m[1]) atts[m[1].toLowerCase()] = m[2] ?? "";
    else if (m[3]) atts[m[3].toLowerCase()] = m[4] ?? "";
    else if (m[5]) atts[m[5].toLowerCase()] = m[6] ?? "";
  }
  return atts;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The marker the converter turns into an ::embed line. */
export const embedMarker = (url: string) => `<wv-embed data-url="${escapeAttr(url)}"></wv-embed>`;

const mediaLink = (url: string) => `<p><a href="${escapeAttr(url)}">${escapeAttr(url)}</a></p>`;

export function expandShortcodes(html: string, ctx: ShortcodeContext): ShortcodeResult {
  const warnings: string[] = [];
  const out = html.replace(shortcodeRegex(HANDLED), (whole, open: string, name: string, attText: string, _selfClose: string, inner: string | undefined, close: string) => {
    if (open === "[" && close === "]") return whole.slice(1, -1); // [[caption]] is the literal text [caption]
    const atts = parseAtts(attText ?? "");
    const content = inner ?? "";
    switch (name) {
      case "caption":
      case "wp_caption": {
        // The image (optionally linked), then the caption text; older posts put it in caption="".
        const m = /^\s*((?:<a\s[^>]*>\s*)?<img\s[^>]*>(?:\s*<\/a>)?)([\s\S]*)$/i.exec(content);
        const image = m ? m[1]! : content;
        const caption = (atts.caption ?? (m ? m[2]! : "")).trim();
        return `<figure>${image}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`;
      }
      case "embed": {
        const url = (content || atts.src || "").trim();
        if (!url) return "";
        if (parseEmbedUrl(url)) return embedMarker(url);
        warnings.push(`an [embed] of ${hostOf(url)} is kept as a link (Writavo embeds YouTube, Vimeo and X)`);
        return mediaLink(url);
      }
      case "gallery": {
        let ids = (atts.ids ?? atts.include ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) ids = ctx.attachmentsByParent.get(ctx.postId) ?? [];
        const images = ids.flatMap((id) => {
          const a = ctx.attachments.get(id);
          return a ? [`<figure><img src="${escapeAttr(a.url)}" alt="${escapeAttr(a.alt ?? "")}"></figure>`] : [];
        });
        if (images.length < ids.length) warnings.push(`a gallery names ${ids.length - images.length} image(s) that are not in the export; they are left out`);
        if (ids.length === 0) warnings.push("a gallery with no images in the export is left out");
        else warnings.push(`a gallery of ${images.length} image(s) becomes a sequence of images`);
        return images.join("\n");
      }
      case "video":
      case "audio": {
        const url = atts.src ?? atts.mp4 ?? atts.m4v ?? atts.webm ?? atts.ogv ?? atts.mp3 ?? atts.ogg ?? atts.wav ?? atts.m4a ?? "";
        if (!url) return "";
        if (parseEmbedUrl(url)) return embedMarker(url);
        warnings.push(`a [${name}] file is kept as a link to its original URL (the media library takes images only)`);
        return mediaLink(url);
      }
      default: {
        warnings.push(`a [${name}] shortcode is left as written`);
        return whole;
      }
    }
  });

  // A URL alone on its line is an embed in WordPress (autoembed). Only the allow-listed providers
  // become embeds here; any other stays the link it is.
  const embedded = out.replace(/^(\s*)(https?:\/\/[^\s<>"]+)(\s*)$/gim, (whole, _pre, url: string) =>
    parseEmbedUrl(url) ? embedMarker(url) : whole,
  );

  // Anything left that looks like a shortcode: a name that starts with a letter, in brackets.
  const unknown = new Set<string>();
  for (const m of embedded.matchAll(/\[([a-z][a-z0-9_-]*)(?=[\s\]/])[^\]]*\]/gi)) {
    const name = m[1]!.toLowerCase();
    if (!HANDLED.includes(name)) unknown.add(name);
  }
  return { html: embedded, warnings, unknown: [...unknown] };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "an unknown site";
  }
}
