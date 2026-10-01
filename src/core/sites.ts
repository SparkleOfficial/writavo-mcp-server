import type { ImportJobStore } from "../import/jobs.js";

/**
 * One connection, several Sites (0154).
 *
 * A key still belongs to exactly one Site, so reaching another Site means using another key. The
 * host owns that: it knows which Sites the person put in the connection and holds (or can obtain)
 * the key for each. The core only asks, per tool call, "which key for this Site?", and never sees
 * more than the one it is handed.
 */
export interface ConnectionSite {
  id: string;
  name: string;
  domain: string | null;
  /** The Site every tool acts on when `site` is left out. */
  isDefault: boolean;
  /** False when the connection includes the Site but cannot act there right now; `note` says why. */
  available: boolean;
  note?: string;
}

export interface SiteAccess {
  apiKey: string;
  /** import_content's stored imports belong to a Site, so they follow the Site chosen. */
  importJobs?: ImportJobStore;
}

export interface SiteRouter {
  list(): Promise<ConnectionSite[]>;
  /** `site` is what the assistant sent: an id, a name or a domain. The error is shown as is. */
  resolve(site: string): Promise<SiteAccess | { error: string }>;
}
