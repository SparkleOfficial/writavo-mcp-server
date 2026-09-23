import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

/**
 * The saved sign-in, shared with the CLI (packages/cli/src/credentials.ts is a deliberate copy:
 * the two packages are published separately and neither may import the other).
 *
 * Written only by a browser sign-in (the MCP `login` tool or `writavo login`), after a person
 * approved the request. The file holds a live secret key, so it is treated like an SSH key: its
 * directory is 0700, the file is 0600, and it is replaced atomically so a crash mid write can
 * never leave half a key behind or a moment where the file is readable by anyone else.
 */
export interface StoredCredentials {
  version: 1;
  api_key: string;
  key_id: string;
  key_prefix: string;
  website: { id: string; name: string };
  scopes: string[];
  expires_at: string | null;
  created_at: string;
}

export type CredentialsRead =
  | { state: "missing"; path: string }
  | { state: "invalid"; path: string; reason: string }
  | { state: "expired"; path: string; credentials: StoredCredentials }
  | { state: "valid"; path: string; credentials: StoredCredentials };

/**
 * $XDG_CONFIG_HOME/writavo/credentials.json, else ~/.config/writavo/credentials.json, and
 * %APPDATA%\writavo\credentials.json on Windows. Resolved on every call rather than once, so the
 * location follows the environment the process actually has.
 */
export function credentialsPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(appData, "writavo", "credentials.json");
  }
  // The XDG specification says a relative value is invalid and must be ignored.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config");
  return join(base, "writavo", "credentials.json");
}

export function isExpired(credentials: Pick<StoredCredentials, "expires_at">, now = Date.now()): boolean {
  if (!credentials.expires_at) return false;
  const at = Date.parse(credentials.expires_at);
  return Number.isFinite(at) && at <= now;
}

const isString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function parse(raw: string): StoredCredentials | string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "it is not valid JSON";
  }
  const c = value as Partial<StoredCredentials> | null;
  if (!c || typeof c !== "object") return "it is not a JSON object";
  if (c.version !== 1) return "it was written by a different version of this tool";
  if (!isString(c.api_key) || !/^wv_(sk|pub)_/.test(c.api_key)) return "it does not hold a Writavo key";
  if (!c.website || !isString(c.website.id) || typeof c.website.name !== "string") return "it names no Site";
  return {
    version: 1,
    api_key: c.api_key,
    key_id: String(c.key_id ?? ""),
    key_prefix: String(c.key_prefix ?? c.api_key.slice(0, 12)),
    website: { id: c.website.id, name: c.website.name },
    scopes: Array.isArray(c.scopes) ? c.scopes.map(String) : [],
    expires_at: isString(c.expires_at) ? c.expires_at : null,
    created_at: String(c.created_at ?? ""),
  };
}

export function readCredentials(): CredentialsRead {
  const path = credentialsPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", path };
    return { state: "invalid", path, reason: `it could not be read (${(err as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const parsed = parse(raw);
  if (typeof parsed === "string") return { state: "invalid", path, reason: parsed };
  if (isExpired(parsed)) return { state: "expired", path, credentials: parsed };
  return { state: "valid", path, credentials: parsed };
}

/** Atomic replace: a private temp file in the same directory, then a rename over the old one. */
export function writeCredentials(credentials: StoredCredentials): string {
  const path = credentialsPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir leaves an existing directory's mode alone. This one is ours, so it is tightened.
  if (process.platform !== "win32") chmodSync(dir, 0o700);

  const tmp = join(dir, `.credentials.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    // "wx" refuses to follow or reuse anything already at the temp path.
    writeFileSync(tmp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return path;
}

/** True when there was a file to delete. */
export function deleteCredentials(): boolean {
  const path = credentialsPath();
  const existed = existsSync(path);
  rmSync(path, { force: true });
  return existed;
}
