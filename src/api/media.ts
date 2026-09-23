import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { apiRequest, putPresigned } from "./client.js";

/**
 * The three step upload, shared by upload_media and the importer so there is one implementation
 * of the handshake to get right. Throws WritavoApiError for anything the API refused and
 * MediaError for anything decided locally.
 */

export class MediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaError";
  }
}

/** The API's own ceiling (writavo-api-media MAX_UPLOAD_BYTES). Checked here first to save a round trip. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const TYPE_BY_EXTENSION: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  avif: "image/avif",
};

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/webp": "webp",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/avif": "avif",
};

export const ACCEPTED_TYPES = [...new Set(Object.values(TYPE_BY_EXTENSION))];

export function contentTypeFor(fileName: string): string | undefined {
  const extension = fileName.includes(".") ? (fileName.split(".").pop()?.toLowerCase() ?? "") : "";
  return TYPE_BY_EXTENSION[extension];
}

export interface FetchedImage {
  bytes: Uint8Array;
  fileName: string;
  /** Undefined when neither the filename nor the response says it is an accepted image type. */
  contentType: string | undefined;
}

export interface UploadReservation {
  upload_id: string;
  upload_url: string | null;
  method: string;
  headers?: Record<string, string>;
  expires_at: string;
  max_size_bytes?: number;
}

/**
 * Fetch a public image over https, refusing anything larger than the API would accept before
 * the whole body is read. The type comes from the filename, then from the response header, and
 * the API reads the real type from the bytes either way; a caller with no type refuses.
 */
export async function fetchImage(sourceUrl: string, maxBytes = MAX_IMAGE_BYTES, timeoutMs = 30_000): Promise<FetchedImage> {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    throw new MediaError("the URL is not valid");
  }
  if (parsed.protocol !== "https:") throw new MediaError("the URL is not https");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new MediaError(/abort/i.test(reason) ? "fetching it timed out" : `it could not be fetched (${reason})`);
    }
    if (!response.ok) throw new MediaError(`fetching it returned status ${response.status}`);

    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new MediaError(`it is ${declared} bytes and the limit is ${maxBytes}`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new MediaError(`it is larger than the ${maxBytes} byte limit`);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (bytes.byteLength === 0) throw new MediaError("it is empty");

    let fileName = "image";
    try {
      fileName = basename(decodeURIComponent(parsed.pathname)) || "image";
    } catch {
      fileName = basename(parsed.pathname) || "image";
    }
    fileName = fileName.replace(/[^\w.\-]+/g, "-").slice(-200) || "image";

    const headerType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const contentType = contentTypeFor(fileName) ?? (ACCEPTED_TYPES.includes(headerType) ? headerType : undefined);
    if (contentType && !contentTypeFor(fileName)) fileName = `${fileName}.${EXTENSION_BY_TYPE[contentType]}`;

    return { bytes, fileName, contentType };
  } finally {
    clearTimeout(timer);
  }
}

export interface UploadInput {
  bytes: Uint8Array;
  fileName: string;
  contentType: string;
  altText?: string;
  bucket?: "blog-images" | "author-avatars";
}

/** Reserve, transfer, register. Returns the registered asset, whose `url` is the public one. */
export async function uploadImage(input: UploadInput): Promise<Record<string, unknown>> {
  // Step 1: reserve.
  const reservation = await apiRequest<UploadReservation>({
    method: "POST",
    path: "/media/upload-url",
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      file_name: input.fileName,
      content_type: input.contentType,
      size_bytes: input.bytes.byteLength,
      ...(input.bucket ? { bucket: input.bucket } : {}),
    },
  });

  if (reservation.data.max_size_bytes && input.bytes.byteLength > reservation.data.max_size_bytes) {
    throw new MediaError(
      `${input.fileName} is ${input.bytes.byteLength} bytes and the limit for this upload is ${reservation.data.max_size_bytes}. Resize it and try again.`,
    );
  }
  if (!reservation.data.upload_url) {
    throw new MediaError(
      "The API returned a reservation with no upload URL, which happens when an idempotent request is replayed. Try again to get a fresh reservation.",
    );
  }

  // Step 2: transfer. No authorization header: the signature in the URL is the credential.
  await putPresigned(reservation.data.upload_url, input.bytes, {
    "Content-Type": input.contentType,
    ...(reservation.data.headers ?? {}),
  });

  // Step 3: register. Until this lands the object is swept and is not part of the library.
  const asset = await apiRequest<Record<string, unknown>>({
    method: "POST",
    path: "/media",
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      upload_id: reservation.data.upload_id,
      ...(input.altText === undefined ? {} : { alt_text: input.altText }),
    },
  });
  return asset.data;
}
