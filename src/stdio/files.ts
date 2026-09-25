import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { toolError } from "../errors.js";
import { normaliseProgress, type ImportProgress, type ProgressStore } from "../import/progress.js";
import type { ImportSource } from "../import/engine.js";
import type { ImportFileSupport } from "../tools/import-content.js";
import type { LocalFileReader } from "../tools/upload-media.js";

/**
 * The files the stdio host can read and write, injected into the core's import_content and
 * upload_media as their `path` argument. The core never imports this module: a Worker has no
 * disk, and the tools work there without it.
 */

export function progressPath(filePath: string): string {
  return `${filePath}.writavo-progress.json`;
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
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return "it is not valid JSON";
  }
  return normaliseProgress(value) ?? "it is not a progress file this version understands";
}

/** Atomic, so an interrupted call leaves the previous progress intact rather than half a file. */
export function writeProgress(path: string, progress: ImportProgress): void {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`, { flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** The progress file next to an import file. */
export function fileProgressStore(filePath: string): ProgressStore {
  const location = progressPath(filePath);
  return {
    location,
    read: () => readProgress(location),
    write: (progress) => writeProgress(location, progress),
  };
}

/** import_content's `path`: read and parse the file, and keep progress beside it. */
export const IMPORT_FILES: ImportFileSupport = {
  async open(path: string): Promise<ImportSource | ReturnType<typeof toolError>> {
    if (!isAbsolute(path)) {
      return toolError("import_content needs an absolute path, so there is no ambiguity about which file is meant.");
    }
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      return toolError(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    let document: unknown;
    try {
      document = JSON.parse(raw);
    } catch (err) {
      return toolError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    return { label: path, document, store: fileProgressStore(path), reference: { path }, lockKey: path };
  },
};

/** upload_media's `path`: read a local image. */
export const MEDIA_FILES: LocalFileReader = {
  async read(path: string) {
    if (!isAbsolute(path)) {
      return { error: "upload_media needs an absolute file path, so there is no ambiguity about which file is meant." };
    }
    try {
      return { bytes: new Uint8Array(await readFile(path)), fileName: basename(path) };
    } catch (err) {
      return { error: `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
