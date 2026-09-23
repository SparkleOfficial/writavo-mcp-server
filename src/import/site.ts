import { apiRequest, WritavoApiError, type ApiRequest, type ApiResponse } from "../api/client.js";

/**
 * The reads and writes the importer makes, with the patience a long import needs.
 *
 * apiRequest already retries a 429 once. An import makes hundreds of calls against a per minute
 * budget, so here a rate limit or a busy server is waited out a few more times, honouring
 * Retry-After, before it is reported. A wait that would overrun the call's time budget is not
 * started: the batch stops instead and the next call carries on.
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const TRANSIENT_CODES = new Set([
  "NETWORK_ERROR",
  "RATE_LIMIT_EXCEEDED",
  "IDEMPOTENCY_KEY_IN_FLIGHT",
  "MAINTENANCE",
  "INTERNAL_ERROR",
]);

/** Worth trying again later: the request was fine, the moment was not. */
export function isTransient(err: unknown): boolean {
  return err instanceof WritavoApiError && (TRANSIENT_CODES.has(err.code) || err.status >= 500);
}

export async function call<T>(request: ApiRequest, deadline = Number.POSITIVE_INFINITY): Promise<ApiResponse<T>> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apiRequest<T>(request);
    } catch (err) {
      if (!isTransient(err) || attempt >= 3) throw err;
      const retryAfter = err instanceof WritavoApiError && err.retryAfter ? Number.parseInt(err.retryAfter, 10) * 1000 : NaN;
      const wait = Math.min(Number.isFinite(retryAfter) ? retryAfter : 2_000 * 2 ** attempt, 30_000);
      if (Date.now() + wait > deadline) throw err;
      await sleep(wait);
    }
  }
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

/** Every row of a cursor paginated list, a hundred at a time. */
export async function listAll<T>(path: string, query: [string, string][] = [], deadline?: number): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  // A cursor that never ends is a server bug, not a big Site. Ten thousand pages is a million rows.
  for (let page = 0; page < 10_000; page += 1) {
    const response: ApiResponse<Page<T>> = await call<Page<T>>(
      {
        method: "GET",
        path,
        query: [...query, ["limit", "100"], ...(cursor ? ([["cursor", cursor]] as [string, string][]) : [])],
      },
      deadline,
    );
    rows.push(...(response.data?.items ?? []));
    cursor = response.data?.next_cursor ?? null;
    if (!cursor) break;
  }
  return rows;
}

export interface SiteInfo {
  id: string;
  name: string;
}

export interface SiteTerm {
  id: string;
  slug: string;
  name: string;
}

export interface SiteAuthor {
  id: string;
  name: string;
}

export interface SiteContentType {
  id: string;
  key: string;
  is_active?: boolean;
}

export interface SiteArticle {
  id: string;
  slug: string | null;
  external_id?: string | null;
  status: string;
  published_at: string | null;
}

export const ARTICLE_STATE_FIELDS = "id,slug,external_id,status,published_at";

export async function getSite(): Promise<SiteInfo> {
  const response = await call<SiteInfo>({ method: "GET", path: "/site" });
  return { id: String(response.data?.id ?? ""), name: String(response.data?.name ?? "") };
}

/**
 * The article with this external_id, or null. The match is checked here as well as by the API:
 * a server that ignored the filter would otherwise hand back an unrelated article to overwrite.
 */
export async function findByExternalId(externalId: string, deadline?: number): Promise<SiteArticle | null> {
  const response = await call<Page<SiteArticle>>(
    {
      method: "GET",
      path: "/articles",
      query: [
        ["external_id", externalId],
        ["fields", ARTICLE_STATE_FIELDS],
        ["limit", "2"],
      ],
    },
    deadline,
  );
  return (response.data?.items ?? []).find((a) => a.external_id === externalId) ?? null;
}

export async function findBySlug(slug: string, deadline?: number): Promise<SiteArticle | null> {
  const response = await call<Page<SiteArticle>>(
    {
      method: "GET",
      path: "/articles",
      query: [
        ["slug", slug],
        ["fields", ARTICLE_STATE_FIELDS],
        ["limit", "2"],
      ],
    },
    deadline,
  );
  return (response.data?.items ?? []).find((a) => a.slug === slug) ?? null;
}

export async function getArticleState(id: string, deadline?: number): Promise<SiteArticle> {
  const response = await call<SiteArticle>(
    { method: "GET", path: `/articles/${encodeURIComponent(id)}`, query: [["fields", ARTICLE_STATE_FIELDS]] },
    deadline,
  );
  return response.data;
}
