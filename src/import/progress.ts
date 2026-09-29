/**
 * What an import has done so far. The hosted Worker keeps it in the import job
 * (src/import/jobs.ts). An inline document on a host without job storage has nowhere to keep it,
 * so its progress lives for one call and a re-run is made safe by external_id matching instead.
 *
 * It is what makes a stored import resumable across tool calls (each call does one batch) and
 * across restarts, and what makes a finished import a no-op when it is run again. It is bound to
 * one Site: article ids and re-hosted image URLs mean nothing on another, so progress written for
 * Site A is refused when the key belongs to Site B.
 *
 * This module is the shape only, with no filesystem in it, because the core runs in a Worker.
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
  /** Its media library id (recorded since 0136, for media fields; older copies have none). */
  id?: string;
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
  /** Authors already on the Site whose empty profile fields the import filled in. */
  filled_authors: number;
  images: Record<string, ProgressImage>;
  items: Record<string, ProgressItem>;
  /** The engagement section's delivery, when the document has one (sent after every article). */
  engagement?: EngagementProgress;
  /** The redirects (articles' old_urls + the redirects section), sent after every article. */
  redirects?: RedirectsProgress;
  /**
   * Cost history of articles that were live and left unchanged (publish false), by external_id.
   * It is not public content, so it is written for them anyway, in bulk, after the articles.
   * `hash` is of the entries as sent; `error` is why an item could not be written (settled: the
   * next apply does not retry it).
   */
  cost_history?: Record<string, { hash: string; done: boolean; error?: string }>;
  /** Why the last attempt to send cost history could not deliver it (the next apply tries again). */
  cost_history_error?: string;
  /** The content_types section (0136), applied before anything else. */
  content_types?: ContentTypesProgress;
  /** Entries by external_id (0136): written, then their references and media resolved. */
  entries?: Record<string, EntryProgress>;
  /** Articles' custom_fields by article external_id (0136), applied after every entry exists. */
  custom_fields?: Record<string, { hash: string; done: boolean; error?: string }>;
}

export interface ContentTypesProgress {
  hash: string;
  done: boolean;
  /** The API's plan, as one line ("created product; updated faq"). */
  plan?: string;
  /** Why the Site refused the types (the next apply tries again). */
  error?: string;
}

export interface EntryProgress {
  /** Hash of the file's version of this entry. A change makes it pending again. */
  hash: string;
  id?: string;
  action?: "created" | "updated";
  /** written: the entry exists (references not yet resolved); done: resolved and its status set. */
  stage: "written" | "done";
  outcome: ItemOutcome;
  published?: boolean;
  error?: string;
  warnings?: string[];
  attempts?: number;
  updated_at: string;
}

export interface RedirectsProgress {
  /** Hash of the list as sent: a changed list is sent again from the start (SET, so harmless). */
  hash: string;
  sent: number;
  done: boolean;
  written: { created: number; updated: number; unchanged: number };
  /** What the API skipped, first ones only. */
  problems: string[];
  /** Why the last attempt could not deliver it (the next apply tries again). */
  error?: string;
}

export interface EngagementProgress {
  /** Hash of the section as sent: a changed section is sent again from the start. */
  hash: string;
  daily_sent: number;
  reactions_sent: number;
  done: boolean;
  written: { daily: number; share_rows: number; picks: number };
  /** What the API skipped, first ones only. */
  problems: string[];
  /** Why the last attempt could not deliver it (the next apply tries again). */
  error?: string;
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
    filled_authors: 0,
    images: {},
    items: {},
  };
}

/**
 * Where an import's progress persists between calls, when the host has somewhere to keep it: the
 * import job on the server (the hosted Worker). Async because the store is a network hop away.
 */
export interface ProgressStore {
  /** Where it lives, as replies name it: "the progress file /x.json.writavo-progress.json". */
  location: string;
  /** What the person does to start over when the saved progress cannot be used. */
  resetHint: string;
  /** Null when there is none; a string when there is one that cannot be used. */
  read(): Promise<ImportProgress | null | string>;
  /** Replace it. Atomic, so an interrupted call leaves the previous progress intact. */
  write(progress: ImportProgress): Promise<void>;
}

/** Fill in what an older progress file may lack. Null when it is not one this version reads. */
export function normaliseProgress(value: unknown): ImportProgress | null {
  const p = value as ImportProgress | null;
  if (!p || p.version !== 1 || typeof p.website_id !== "string" || typeof p.items !== "object") return null;
  p.categories ??= {};
  p.tags ??= {};
  p.authors ??= {};
  p.images ??= {};
  p.created ??= { categories: 0, tags: 0, authors: 0 };
  p.filled_authors ??= 0;
  return p;
}
