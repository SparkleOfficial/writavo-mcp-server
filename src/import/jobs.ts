import type { ImportSource } from "./engine.js";
import { normaliseProgress, type ImportProgress, type ProgressStore } from "./progress.js";

/**
 * Import jobs: an import document kept on the server, with its progress beside it, under an
 * import_id. The hosted Worker provides the storage (one Durable Object per job); this module is
 * what the core needs from it and the logic that belongs with the import format.
 *
 * Why they exist. A hosted server cannot read the person's files, and one tool call stops after
 * about 35 seconds, so a real blog (a hundred articles and a few hundred images) takes many calls.
 * Without a job, every call had to carry the articles still to do, inline, through the model.
 * With one, the document arrives ONCE (inline in parts, from an https URL, or uploaded straight to
 * the server with an upload link) and every later call is just { import_id }.
 *
 * A job belongs to an owner the host chooses: on the hosted server the Site the sign-in is for
 * (so a new sign-in, which is a new key, still reaches it), for a raw key that key. The store
 * answers for any other owner's id exactly as for an id that never existed.
 */

/** A stored document's ceiling. The Worker holds it, parsed, in memory for the length of a call. */
export const MAX_JOB_BYTES = 10 * 1024 * 1024;
/** A job, its document and its progress are deleted this long after the job was last used. */
export const JOB_TTL_DAYS = 7;
/** How long an upload link works, and a lease holds when a call dies without releasing it. */
export const UPLOAD_LINK_MINUTES = 30;
/** A foreground call's hold: longer than the call can run (FOREGROUND_BUDGET, 25 s), so it only lapses for a call that died. */
const LEASE_MS = 45_000;

/** imp_ + 22 base64url characters (128 random bits). */
export const IMPORT_ID_RE = /^imp_[A-Za-z0-9_-]{22}$/;

export interface ImportJobInfo {
  /** awaiting_upload: made by upload: true and nothing received yet. */
  status: "awaiting_upload" | "ready";
  /** Size of the stored document in bytes; 0 while awaiting upload. */
  bytes: number;
  /** A WordPress export being converted on the server (or why converting it failed). */
  conversion?: { state: "pulling" | "converting" | "failed"; posts: number; pages: number; converted: number; error: string | null };
  created_at: string;
  updated_at: string;
}

export interface ImportUploadLink {
  /** Where to PUT the document. */
  url: string;
  /** The Authorization bearer for that PUT. Single use, this job only. */
  token: string;
  expires_at: string;
}

/**
 * What the host stores. Every method is scoped to the connection the host built it for: an
 * import_id another connection created behaves as if it did not exist (404, not 403).
 */
export interface ImportJobStore {
  /** A new, empty job. Returns its import_id. */
  create(): Promise<string>;
  info(importId: string): Promise<ImportJobInfo | null>;
  getDocument(importId: string): Promise<string | null>;
  putDocument(importId: string, json: string): Promise<void>;
  readProgress(importId: string): Promise<string | null>;
  writeProgress(importId: string, json: string): Promise<void>;
  /** ok when `holder` now holds the job (for ttlMs); otherwise who holds it holds it until `until`. */
  acquire(importId: string, holder: string, ttlMs: number): Promise<{ ok: boolean; until: number | null }>;
  release(importId: string, holder: string): Promise<void>;
  /** A one-time link to PUT the document to, for a client that can run a command (curl). */
  createUpload(importId: string): Promise<ImportUploadLink>;
  /**
   * Run the import on the server until it is done, with nobody connected (optional: a host
   * without a background runner leaves it out). `apiKey` is held, encrypted, only while it runs.
   */
  startBackground?(importId: string, run: BackgroundRun): Promise<BackgroundStatus>;
  status?(importId: string): Promise<BackgroundStatus | null>;
  cancel?(importId: string): Promise<BackgroundStatus | null>;
  /**
   * The store does the document work itself (optional; the hosted Durable Object does). A
   * 4 MB document takes far more CPU to parse and check than a Cloudflare Worker request is
   * allowed on the free plan (10 ms; a Durable Object gets 30 s), so on the hosted server the
   * Worker only relays: the part, the URL, the run, and the reply come back as text.
   */
  addPart?(importId: string, part: unknown): Promise<PartOutcome>;
  addFromUrl?(importId: string, url: string): Promise<PartOutcome>;
  /** A live WordPress site read over its REST API on the server (read only), then converted. */
  addFromWordPress?(importId: string, site: { url: string; username?: string; applicationPassword?: string }): Promise<PartOutcome>;
  runStored?(importId: string, run: StoredRun): Promise<StoredRunResult>;
}

/** converting: a WordPress export was received and is being converted on the server; the dry run waits for it. */
export type PartOutcome = { ok: true; bytes: number; articles: number | null; converting?: boolean } | { ok: false; error: string };

/** One foreground call's worth of an import, run where the document is. */
export interface StoredRun {
  apiKey: string;
  dryRun: boolean;
  confirm: boolean;
  publish: boolean;
  rehostImages: boolean;
  retryFailed: boolean;
  batchSize?: number;
}

export interface StoredRunResult {
  text: string;
  isError: boolean;
  importStatus?: import("./engine.js").ImportRunStatus;
}

/** What a background run applies: the same switches as a foreground apply. */
export interface BackgroundRun {
  apiKey: string;
  publish: boolean;
  confirm: boolean;
  rehost_images: boolean;
  retry_failed: boolean;
}

/** A background run's state, as a status reply shows it. */
export interface BackgroundStatus {
  /** idle: never started in the background. */
  state: "idle" | "running" | "complete" | "failed" | "cancelled" | "waiting_for_confirm";
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  batches: number;
  /** Why it stopped, for failed and waiting_for_confirm. */
  error: string | null;
  /** The last batch's own report, trimmed. */
  last_report: string | null;
  progress: import("./engine.js").ImportProgressSummary;
}

export const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength;

/** The job as the engine sees it: its document, its progress store and its lease. */
export function jobSource(store: ImportJobStore, importId: string, document: unknown, leaseMs = LEASE_MS): ImportSource {
  const location = `the import job ${importId} (kept on Writavo's server for ${JOB_TTL_DAYS} days after its last use)`;
  const progress: ProgressStore = {
    location,
    resetHint: "Start a new import instead: send the document again without import_id",
    async read(): Promise<ImportProgress | null | string> {
      const raw = await store.readProgress(importId);
      if (raw === null) return null;
      try {
        return normaliseProgress(JSON.parse(raw)) ?? "it is not progress this version understands";
      } catch {
        return "it is not valid JSON";
      }
    },
    async write(value: ImportProgress): Promise<void> {
      await store.writeProgress(importId, JSON.stringify(value));
    },
  };
  const holder = crypto.randomUUID();
  return {
    label: `the import ${importId}`,
    document,
    store: progress,
    reference: { import_id: importId },
    lease: {
      async acquire() {
        const got = await store.acquire(importId, holder, leaseMs);
        return got.ok ? { ok: true as const } : { ok: false as const, until: got.until };
      },
      release: () => store.release(importId, holder),
    },
    // A job keeps its own progress, so a call may do as much as fits in its time.
    defaultBatchSize: 100,
  };
}

// ---------------------------------------------------------------------------
// Documents in parts
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/** Entries of `base` and `part` merged on `key`: a part's entry replaces the stored one with the same key, in place. */
function mergeOn(base: unknown, part: unknown, key: string | ((entry: Json) => string | undefined)): unknown[] | undefined {
  const a = Array.isArray(base) ? base : [];
  const b = Array.isArray(part) ? part : [];
  if (!Array.isArray(base) && !Array.isArray(part)) return undefined;
  const keyOf = (entry: unknown): string | undefined => {
    if (!isObject(entry)) return undefined;
    if (typeof key === "function") return key(entry);
    return typeof entry[key] === "string" ? (entry[key] as string) : undefined;
  };
  const out = [...a];
  const at = new Map<unknown, number>();
  out.forEach((entry, i) => {
    const k = keyOf(entry);
    if (k !== undefined) at.set(k, i);
  });
  for (const entry of b) {
    const k = keyOf(entry);
    const existing = k === undefined ? undefined : at.get(k);
    if (existing !== undefined) out[existing] = entry;
    else {
      if (k !== undefined) at.set(k, out.length);
      out.push(entry);
    }
  }
  return out;
}

/**
 * A part added to a stored document. authors merge on ref, categories and tags on slug, articles,
 * entries and comments on external_id, content types on api_id, redirects on their old URL; an entry with the same key replaces the stored one, so a corrected entry is
 * simply sent again. The part's format, version and source win when it has them. Nothing here
 * validates: the dry run checks the merged whole.
 */
export function mergeImportDocuments(stored: unknown, part: unknown): Json | string {
  if (!isObject(part)) return "the new part is not a JSON object";
  if (!isObject(stored)) return part;
  const merged: Json = { ...stored };
  for (const field of ["format", "version", "source"] as const) if (field in part) merged[field] = part[field];
  // 0136: content types merge on api_id, entries (and 0160 comments) on external_id; redirects on their old URL.
  for (const [field, key] of [["authors", "ref"], ["categories", "slug"], ["tags", "slug"], ["articles", "external_id"], ["content_types", "api_id"], ["entries", "external_id"], ["comments", "external_id"], ["redirects", "from"]] as const) {
    const value = mergeOn(stored[field], part[field], key);
    if (value !== undefined) merged[field] = value;
  }
  // Engagement rows merge on their post (external_id or slug) and day, picks on post and visitor.
  if (isObject(part.engagement)) {
    const stored = isObject(merged.engagement) ? (merged.engagement as Json) : {};
    const post = (e: Json) => (typeof e.external_id === "string" ? e.external_id : typeof e.slug === "string" ? `slug:${e.slug}` : undefined);
    const engagement: Json = { ...stored };
    const daily = mergeOn(stored.daily, part.engagement.daily, (e) => (post(e) && typeof e.day === "string" ? `${post(e)}|${e.day}` : undefined));
    const reactions = mergeOn(stored.reactions, part.engagement.reactions, (e) => (post(e) && typeof e.visitor_id === "string" ? `${post(e)}|${e.visitor_id}` : undefined));
    if (daily !== undefined) engagement.daily = daily;
    if (reactions !== undefined) engagement.reactions = reactions;
    merged.engagement = engagement;
  }
  // SEO rows merge on their natural keys: keywords ignoring case and spacing, competitors on the
  // domain as written, positions on keyword and day.
  if (isObject(part.seo)) {
    const stored = isObject(merged.seo) ? (merged.seo as Json) : {};
    const kw = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").toLowerCase() : undefined);
    const seo: Json = { ...stored };
    const keywords = mergeOn(stored.keywords, part.seo.keywords, (e) => kw(e.keyword));
    const competitors = mergeOn(stored.competitors, part.seo.competitors, (e) => (typeof e.domain === "string" ? e.domain.trim().toLowerCase() : undefined));
    const positions = mergeOn(stored.positions, part.seo.positions, (e) => (kw(e.keyword) && typeof e.day === "string" ? `${kw(e.keyword)}|${e.day}` : undefined));
    if (keywords !== undefined) seo.keywords = keywords;
    if (competitors !== undefined) seo.competitors = competitors;
    if (positions !== undefined) seo.positions = positions;
    merged.seo = seo;
  }
  // The AI writing profile: a part's fields replace the stored ones, prompt_vars name by name.
  if (isObject(part.profile)) {
    const stored = isObject(merged.profile) ? (merged.profile as Json) : {};
    const profile: Json = { ...stored, ...part.profile };
    if (isObject(stored.prompt_vars) && isObject(part.profile.prompt_vars)) {
      profile.prompt_vars = { ...(stored.prompt_vars as Json), ...(part.profile.prompt_vars as Json) };
    }
    merged.profile = profile;
  }
  // A second converted export: its summary replaces the first's, its per-article notes join them.
  if (isObject(part.conversion)) {
    const before = isObject(merged.conversion) && isObject((merged.conversion as Json).items) ? ((merged.conversion as Json).items as Json) : {};
    const after = isObject(part.conversion.items) ? (part.conversion.items as Json) : {};
    merged.conversion = { ...part.conversion, items: { ...before, ...after } };
  }
  for (const field of Object.keys(part)) if (!(field in merged)) merged[field] = part[field];
  return merged;
}

// ---------------------------------------------------------------------------
// A document by URL
// ---------------------------------------------------------------------------

/**
 * GET an import document from an https URL (a signed storage URL, a gist's raw URL). Anonymous:
 * no credential of ours is ever sent, and the hosted Worker's fetch cannot reach Writavo's own
 * zone (global_fetch_strictly_public). Text, or why not.
 */
export async function fetchImportDocument(url: string, timeoutMs = 30_000): Promise<{ text: string } | { error: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: "url is not a valid URL" };
  }
  if (parsed.protocol !== "https:") return { error: "url must be https" };
  if (parsed.username || parsed.password) return { error: "url must not carry a user name or password; use a signed URL instead" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(parsed, {
        signal: controller.signal,
        redirect: "follow",
        headers: { Accept: "application/json, text/plain;q=0.9, */*;q=0.1" },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { error: /abort/i.test(reason) ? `fetching it took longer than ${timeoutMs / 1000} seconds` : `it could not be fetched (${reason})` };
    }
    if (response.url && !response.url.startsWith("https://")) return { error: "it redirected to a URL that is not https" };
    if (!response.ok) return { error: `fetching it returned HTTP ${response.status}` };
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_JOB_BYTES) {
      return { error: `it is ${declared} bytes, over the ${MAX_JOB_BYTES / 1024 / 1024} MB limit for one import` };
    }
    if (!response.body) return { text: "" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JOB_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { error: `it is over the ${MAX_JOB_BYTES / 1024 / 1024} MB limit for one import` };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { text: new TextDecoder().decode(bytes) };
  } finally {
    clearTimeout(timer);
  }
}
