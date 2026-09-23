import type { ImportArticle } from "./format.js";

/**
 * Finding and rewriting image URLs, and nothing else. An import must keep the customer's prose
 * byte for byte: the only edit allowed to content is swapping an image URL inside markdown image
 * syntax for the URL of its re-hosted copy.
 */

/** `![alt](url)`, `![alt](<url>)` and `![alt](url "title")`. Reference-style images are left alone. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=/gi;

export type ImageKind = "featured" | "inline" | "howto";

export interface ImageRef {
  url: string;
  alt: string | undefined;
  kind: ImageKind;
}

export function markdownImages(content: string): { url: string; alt: string }[] {
  const found: { url: string; alt: string }[] = [];
  for (const match of content.matchAll(MARKDOWN_IMAGE)) found.push({ alt: match[1] ?? "", url: match[2]! });
  return found;
}

export function htmlImageCount(content: string | null | undefined): number {
  return content ? (content.match(HTML_IMAGE) ?? []).length : 0;
}

/** Replace only the URL inside each markdown image whose URL has a replacement. */
export function rewriteMarkdownImages(content: string, replacement: (url: string) => string | undefined): string {
  return content.replace(MARKDOWN_IMAGE, (match: string, _alt: string, url: string) => {
    const next = replacement(url);
    if (!next || next === url) return match;
    // The alt text cannot contain "]", so the first "](" is where the destination starts.
    const at = match.indexOf(url, match.indexOf("](") + 2);
    return at === -1 ? match : `${match.slice(0, at)}${next}${match.slice(at + url.length)}`;
  });
}

/** Every image an article carries, in the order they appear, duplicates included. */
export function articleImages(article: ImportArticle): ImageRef[] {
  const refs: ImageRef[] = [];
  if (article.featured_image?.url) {
    refs.push({ url: article.featured_image.url, alt: article.featured_image.alt, kind: "featured" });
  }
  for (const image of markdownImages(article.content ?? "")) {
    refs.push({ url: image.url, alt: image.alt || undefined, kind: "inline" });
  }
  for (const step of article.howto_steps ?? []) {
    if (step.image_url) refs.push({ url: step.image_url, alt: step.name, kind: "howto" });
  }
  return refs;
}

export const isHttps = (url: string): boolean => /^https:\/\//i.test(url);
