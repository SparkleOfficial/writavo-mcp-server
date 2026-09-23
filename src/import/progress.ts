import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * What an import has done so far, kept next to the import file as <file>.writavo-progress.json.
 *
 * It is what makes an import resumable across tool calls (each call does one batch) and across
 * restarts, and what makes a finished import a no-op when it is run again. It is bound to one
 * Site: article ids and re-hosted image URLs mean nothing on another, so a progress file written
 * for Site A is refused when the key belongs to Site B.
 */

export type ItemOutcome =
  /** Written, and published if it was going to be. */
  | "done"
  /** Left unchanged because it is live on the Site and this run may not touch live content. */
  | "deferred"
  /** Not written for a reason that needs a person (a slug another article owns). */
  | "skipped"
  /** The API refused it. */
  | "failed"
  /** A transient failure. Tried again on the next call. */
  | "retry";

export interface ProgressItem {
  /** Hash of the file's version of this article. A change to it makes the item pending again. */
  hash: string;
  outcome: ItemOutcome;
  article_id?: string;
  action?: "created" | "updated";
  published?: boolean;
  error?: string;
  warnings?: string[];
  attempts?: number;
  updated_at: string;
}

export interface ProgressImage {
  /** The re-hosted URL, when the copy worked. */
  url?: string;
  /** Why it did not, when it did not. The original URL is kept in the content. */
  error?: string;
}

export interface ImportProgress {
  version: 1;
  file: string;
  website_id: string;
  website_name: string;
  started_at: string;
  updated_at: string;
  categories: Record<string, string>;
  tags: Record<string, string>;
  authors: Record<string, string>;
  created: { categories: number; tags: number; authors: number };
  images: Record<string, ProgressImage>;
  items: Record<string, ProgressItem>;
}

export function progressPath(filePath: string): string {
  return `${filePath}.writavo-progress.json`;
}

export function newProgress(filePath: string, website: { id: string; name: string }): ImportProgress {
  const now = new Date().toISOString();
  return {
    version: 1,
    file: filePath,
    website_id: website.id,
    website_name: website.name,
    started_at: now,
    updated_at: now,
    categories: {},
    tags: {},
    authors: {},
    created: { categories: 0, tags: 0, authors: 0 },
    images: {},
    items: {},
  };
}

/** Null when there is none; a string when there is one that cannot be used. */
export function readProgress(path: string): ImportProgress | null | string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `it could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})`;
  }
  try {
    const value = JSON.parse(raw) as ImportProgress;
    if (value?.version !== 1 || typeof value.website_id !== "string" || typeof value.items !== "object") {
      return "it is not a progress file this version understands";
    }
    value.categories ??= {};
    value.tags ??= {};
    value.authors ??= {};
    value.images ??= {};
    value.created ??= { categories: 0, tags: 0, authors: 0 };
    return value;
  } catch {
    return "it is not valid JSON";
  }
}

/** Atomic, so an interrupted call leaves the previous progress intact rather than half a file. */
export function writeProgress(path: string, progress: ImportProgress): void {
  progress.updated_at = new Date().toISOString();
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
