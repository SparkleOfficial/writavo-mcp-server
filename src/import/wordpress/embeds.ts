/**
 * The embed allow-list and line syntax, MIRRORED from packages/types/src/embeds.ts in the Writavo
 * repository (this package is published on its own and cannot import it). Keep the two in step:
 * a URL this file turns into an ::embed line must be one the blog renders as a player, or the
 * line shows as a plain link. The blog is the authority; this copy only decides what to write.
 */

export type EmbedProvider = "youtube" | "vimeo" | "x";

const ID_PATTERNS: Record<EmbedProvider, RegExp> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  vimeo: /^\d{1,12}$/,
  x: /^\d{1,25}$/,
};

/** An allow-listed provider + id for a URL, or null. https only (a protocol-relative URL counts). */
export function parseEmbedUrl(raw: string): { provider: EmbedProvider; id: string } | null {
  let u: URL;
  try {
    u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  let found: { provider: EmbedProvider; id: string } | null = null;
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") found = { provider: "youtube", id: u.searchParams.get("v") ?? "" };
    else if (parts[0] === "embed" || parts[0] === "shorts" || parts[0] === "live" || parts[0] === "v") found = { provider: "youtube", id: parts[1] ?? "" };
  } else if (host === "youtu.be") {
    found = { provider: "youtube", id: parts[0] ?? "" };
  } else if (host === "vimeo.com") {
    const id = parts.find((p) => /^\d+$/.test(p));
    if (id) found = { provider: "vimeo", id };
  } else if (host === "player.vimeo.com" && parts[0] === "video") {
    found = { provider: "vimeo", id: parts[1] ?? "" };
  } else if (host === "x.com" || host === "twitter.com" || host === "mobile.twitter.com") {
    const i = parts.indexOf("status");
    if (i >= 0) found = { provider: "x", id: parts[i + 1] ?? "" };
  }
  return found && ID_PATTERNS[found.provider].test(found.id) ? found : null;
}

/** The canonical https URL written into the line (a protocol-relative iframe src made absolute). */
export function embedUrl(raw: string): string {
  return raw.startsWith("//") ? `https:${raw}` : raw;
}

/** One line of its own in the markdown: ::embed{url="..."}. */
export function embedLine(url: string): string {
  return `::embed{url="${embedUrl(url).replace(/"/g, "%22")}"}`;
}

/** The whole line, as the blog recognises it. */
export const EMBED_LINE = /^::embed\{url="([^"\s]{1,2048})"\}$/;
