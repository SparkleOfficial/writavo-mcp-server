import { addToContext, assemble, CONVERTED_TYPES, convertPost, emptyContext, type MapOptions, type PostResult, type WordPressConversion, type WpContext } from "./map.js";
import type { WpComment, WpItem } from "./model.js";
import { looksLikeWxr, WxrReader } from "./wxr.js";

/**
 * A WordPress export converted in STAGES, for a host with a per-call CPU limit (the hosted import's
 * Durable Object: about 30 s of CPU and 128 MB per invocation).
 *
 * Measured 2026-09-28 on a 5,000-post export (15 MB): reading the XML costs about 0.4 s of CPU;
 * converting the posts' HTML about 2 ms each, 10 s or more in all, and holding every post while
 * converting reached the memory ceiling. So:
 *   1. stage: the upload is read as it streams in; posts go to storage in pages, everything else
 *      (authors, terms, attachments) into a small context. Cheap, and nothing is held whole.
 *   2. convert: pages are converted a few at a time, each call stopping at its time budget and
 *      recording where it got to; the host calls again (an alarm) until every page is done.
 *   3. assemble: the per-post results become the import document, exactly as a one-go conversion
 *      would produce it (map.ts#mapWordPressExport runs the same three functions).
 */

/** Text storage the host provides (values of any length; the host splits them as it needs). */
export interface StageStore {
  put(name: string, text: string): Promise<void>;
  get(name: string): Promise<string | null>;
  remove(names: string[]): Promise<void>;
}

export interface StageState {
  /** Where the posts came from: decides the report's wording and whether content is raw. */
  source?: "wordpress-wxr" | "wordpress-rest";
  /** Pages of posts staged, and how many are converted. */
  pages: number;
  converted: number;
  posts: number;
  bytes: number;
  xmlProblems: number;
  firstXmlProblem: string | null;
  /** REST only: pages of comments read site-wide (a WXR file's sit inside their posts). */
  commentPages?: number;
  /** REST only: why the comments could not be read, for the report. */
  commentsNote?: string | null;
}

/** A page of staged posts: small enough to convert well inside a batch. */
const PAGE_POSTS = 50;
const PAGE_CHARS = 1_500_000;

export const CTX = "wxr:ctx";
export const STATE = "wxr:state";
export const inKey = (n: number) => `wxr:in:${n}`;
const outKey = (n: number) => `wxr:out:${n}`;
/** A page of comments read over the REST API (one response, at most 100). */
export const commentsKey = (n: number) => `wxr:cm:${n}`;
export const PAGE_POSTS_STAGED = 50;

/** The options a staged export is converted with. */
export const stagedOptions = (state: StageState): MapOptions =>
  state.source === "wordpress-rest" ? { source: "wordpress-rest", rawContent: false } : { source: "wordpress-wxr", rawContent: true };

export type StageOutcome =
  | { ok: true; state: StageState }
  | { ok: false; status: 400 | 413; error: string };

/**
 * Stage 1: read a WXR body (text chunks, as it arrives). `head` is what was already read to tell
 * it is WXR. Stops at maxBytes.
 */
export async function stageWxr(
  head: string,
  rest: AsyncIterable<string>,
  store: StageStore,
  maxBytes: number,
  countBytes: () => number,
): Promise<StageOutcome> {
  const ctx: WpContext = emptyContext();
  const state: StageState = { source: "wordpress-wxr", pages: 0, converted: 0, posts: 0, bytes: 0, xmlProblems: 0, firstXmlProblem: null };
  let page: WpItem[] = [];
  let pageChars = 0;
  const pending: Promise<void>[] = [];
  const flush = () => {
    if (!page.length) return;
    const n = state.pages++;
    pending.push(store.put(inKey(n), JSON.stringify(page)));
    page = [];
    pageChars = 0;
  };
  const reader = new WxrReader((record) => {
    switch (record.kind) {
      case "site":
        ctx.site = record.site;
        return;
      case "author":
        ctx.authors.push(record.author);
        return;
      case "term":
        ctx.terms.push(record.term);
        return;
      case "item":
        if (!CONVERTED_TYPES.has(record.item.type)) {
          addToContext(ctx, record.item);
          return;
        }
        page.push(record.item);
        state.posts += 1;
        pageChars += record.item.content.length + record.item.excerpt.length + 1000;
        for (const c of record.item.comments ?? []) pageChars += c.content.length + 300;
        if (page.length >= PAGE_POSTS || pageChars >= PAGE_CHARS) flush();
    }
  });
  try {
    reader.write(head);
    for await (const chunk of rest) {
      if (countBytes() > maxBytes) return { ok: false, status: 413, error: `The WordPress export file is over ${maxBytes / 1024 / 1024} MB.` };
      reader.write(chunk);
      // Keep at most a few page writes in flight.
      if (pending.length > 4) await Promise.all(pending.splice(0));
    }
    reader.end();
  } catch (err) {
    return { ok: false, status: 400, error: `The WordPress export file could not be read: ${err instanceof Error ? err.message : String(err)}.` };
  }
  flush();
  await Promise.all(pending);
  if (!reader.sawRss || !reader.sawWxr) return { ok: false, status: 400, error: "This is not a WordPress export file (WXR)." };
  if (state.posts === 0 && reader.errorCount > 0) {
    return { ok: false, status: 400, error: `The WordPress export file could not be read: ${reader.errors[0] ?? "it is not well-formed XML"}.` };
  }
  state.bytes = countBytes();
  state.xmlProblems = reader.errorCount;
  state.firstXmlProblem = reader.errors[0] ?? null;
  await store.put(CTX, JSON.stringify(ctx));
  await store.put(STATE, JSON.stringify(state));
  return { ok: true, state };
}

export async function readStageState(store: StageStore): Promise<StageState | null> {
  const raw = await store.get(STATE);
  return raw ? (JSON.parse(raw) as StageState) : null;
}

/**
 * Stage 2: convert staged pages until `deadline` (epoch ms; checked between pages, and a page is
 * about a second of CPU at most). Returns the state after this call.
 */
export async function convertStaged(store: StageStore, deadline: number, opts: MapOptions, clock: () => number = Date.now): Promise<StageState> {
  const state = await readStageState(store);
  if (!state) throw new Error("nothing is staged");
  const ctx = JSON.parse((await store.get(CTX)) ?? "null") as WpContext;
  while (state.converted < state.pages && clock() < deadline) {
    const n = state.converted;
    const items = JSON.parse((await store.get(inKey(n))) ?? "[]") as WpItem[];
    const results: PostResult[] = items.map((item) => convertPost(ctx, item, opts));
    await store.put(outKey(n), JSON.stringify(results));
    state.converted += 1;
    await store.put(STATE, JSON.stringify(state));
  }
  return state;
}

/** Stage 3: the document, once every page is converted. Removes the staged pages. */
export async function assembleStaged(store: StageStore, opts: MapOptions): Promise<WordPressConversion> {
  const state = await readStageState(store);
  if (!state || state.converted < state.pages) throw new Error("the export is not fully converted yet");
  const ctx = JSON.parse((await store.get(CTX)) ?? "null") as WpContext;
  const results: PostResult[] = [];
  for (let n = 0; n < state.pages; n++) results.push(...(JSON.parse((await store.get(outKey(n))) ?? "[]") as PostResult[]));
  const comments: WpComment[] = [];
  for (let n = 0; n < (state.commentPages ?? 0); n++) comments.push(...(JSON.parse((await store.get(commentsKey(n))) ?? "[]") as WpComment[]));
  const conversion = assemble(ctx, results, opts, { comments, commentsNote: state.commentsNote ?? null });
  if (state.xmlProblems > 0) {
    conversion.report.lines.push(
      `The file had ${state.xmlProblems} XML problem(s) (first: ${state.firstXmlProblem}). Reading carried on past them; compare the counts above with the WordPress dashboard.`,
    );
    (conversion.document.conversion as { lines: string[] }).lines = conversion.report.lines.slice(0, 50);
  }
  return conversion;
}

export async function clearStaged(store: StageStore): Promise<void> {
  const state = await readStageState(store);
  const names = [CTX, STATE];
  for (let n = 0; n < (state?.pages ?? 0); n++) names.push(inKey(n), outKey(n));
  for (let n = 0; n < (state?.commentPages ?? 0); n++) names.push(commentsKey(n));
  await store.remove(names);
}

/** Read a body's first few kilobytes; says whether it is WXR, and hands back the rest. */
export async function sniffBody(stream: ReadableStream<Uint8Array>): Promise<{
  head: string;
  wxr: boolean;
  rest: AsyncIterable<string>;
  bytes: () => number;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let head = "";
  let total = 0;
  let ended = false;
  while (head.length < 4096) {
    const next = await reader.read();
    if (next.done) {
      ended = true;
      break;
    }
    total += next.value.byteLength;
    head += decoder.decode(next.value, { stream: true });
  }
  async function* rest(): AsyncIterable<string> {
    if (!ended) {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        yield decoder.decode(next.value, { stream: true });
      }
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  }
  return { head, wxr: looksLikeWxr(head), rest: rest(), bytes: () => total };
}
