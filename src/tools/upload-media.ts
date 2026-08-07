import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { apiRequest, putPresigned } from "../api/client.js";
import { NO_API_KEY_MESSAGE, hasApiKey, keyKind } from "../config.js";
import { formatApiError, publishableKeyRefusal, text, toolError, type ToolResult } from "../errors.js";
import type { ToolArgs } from "./call.js";

/**
 * THE ONLY GROUPED TOOL (API-6 §2). Uploading is a three step handshake across two endpoints and
 * a presigned PUT that must carry no authorization header. A model asked to orchestrate that gets
 * it wrong in ways that leave reserved uploads and orphaned objects behind, so the three steps are
 * one tool. Both endpoints it uses are recorded as refusals in the generated table, with this tool
 * named as the reason, so nothing has silently gone missing from the surface.
 */
export const UPLOAD_MEDIA = {
  name: "upload_media",
  description:
    "Upload an image to the Site's media library and return the asset with a usable url, which you can then set as an article's featured_image_url. Give it either a local file path or a public source_url. It drives the whole three step upload for you: reserve, transfer the bytes, register the asset. Changes content on the customer's Site. Nothing becomes public: an asset is only visible where you attach it. Needs a secret key (wv_sk_) carrying the media:write scope.",
  scope: "media:write",
  entitlement: "none",
  inputSchema: {
    file_path: z
      .string()
      .optional()
      .describe("Absolute path to an image on this machine. Give either this or source_url."),
    source_url: z
      .string()
      .optional()
      .describe("Public https URL to fetch the image from. Give either this or file_path."),
    file_name: z
      .string()
      .optional()
      .describe("The filename to store it under. Taken from the path or URL when omitted."),
    content_type: z
      .enum(["image/webp", "image/png", "image/jpeg", "image/gif", "image/avif"])
      .optional()
      .describe(
        "The image type. Guessed from the filename when omitted. It is a hint either way: the API reads the real type from the bytes and refuses anything that is not an allowed image.",
      ),
    alt_text: z
      .string()
      .optional()
      .describe(
        "Accessibility text. Worth sending. It is what screen readers announce and what search engines read, and there is no way to generate it for you.",
      ),
    bucket: z
      .enum(["blog-images", "author-avatars"])
      .optional()
      .describe("Which library the asset belongs to. Defaults to blog-images."),
  },
};

const TYPE_BY_EXTENSION: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  avif: "image/avif",
};

interface UploadReservation {
  upload_id: string;
  upload_url: string | null;
  method: string;
  headers?: Record<string, string>;
  expires_at: string;
  max_size_bytes?: number;
}

export async function handleUploadMedia(rawArgs: ToolArgs): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as {
    file_path?: string;
    source_url?: string;
    file_name?: string;
    content_type?: string;
    alt_text?: string;
    bucket?: string;
  };

  if (!hasApiKey()) return toolError(NO_API_KEY_MESSAGE);
  if (keyKind() === "publishable") return publishableKeyRefusal("upload_media", "media:write");

  if (!args.file_path && !args.source_url) {
    return toolError("upload_media needs either file_path (a local file) or source_url (a public https URL).");
  }
  if (args.file_path && args.source_url) {
    return toolError("upload_media takes file_path or source_url, not both.");
  }

  let bytes: Uint8Array;
  let derivedName: string;

  if (args.file_path) {
    if (!isAbsolute(args.file_path)) {
      return toolError("upload_media needs an absolute file path, so there is no ambiguity about which file is meant.");
    }
    try {
      bytes = new Uint8Array(await readFile(args.file_path));
    } catch (err) {
      return toolError(`Cannot read ${args.file_path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    derivedName = basename(args.file_path);
  } else {
    const source = args.source_url as string;
    let parsed: URL;
    try {
      parsed = new URL(source);
    } catch {
      return toolError("source_url is not a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      return toolError("source_url must be https.");
    }
    try {
      const fetched = await fetch(source);
      if (!fetched.ok) return toolError(`Could not fetch source_url: it returned status ${fetched.status}.`);
      bytes = new Uint8Array(await fetched.arrayBuffer());
    } catch (err) {
      return toolError(`Could not fetch source_url: ${err instanceof Error ? err.message : String(err)}`);
    }
    derivedName = basename(parsed.pathname) || "image";
  }

  const fileName = args.file_name ?? derivedName;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const contentType = args.content_type ?? TYPE_BY_EXTENSION[extension];
  if (!contentType) {
    return toolError(
      `Cannot tell what kind of image ${fileName} is. Pass content_type explicitly. Accepted: ${Object.values(TYPE_BY_EXTENSION).filter((v, i, a) => a.indexOf(v) === i).join(", ")}.`,
    );
  }

  try {
    // Step 1: reserve.
    const reservation = await apiRequest<UploadReservation>({
      method: "POST",
      path: "/media/upload-url",
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        file_name: fileName,
        content_type: contentType,
        size_bytes: bytes.byteLength,
        ...(args.bucket ? { bucket: args.bucket } : {}),
      },
    });

    if (reservation.data.max_size_bytes && bytes.byteLength > reservation.data.max_size_bytes) {
      return toolError(
        `${fileName} is ${bytes.byteLength} bytes and the limit for this upload is ${reservation.data.max_size_bytes}. Resize it and try again.`,
      );
    }
    if (!reservation.data.upload_url) {
      return toolError(
        "The API returned a reservation with no upload URL, which happens when an idempotent request is replayed. Try again to get a fresh reservation.",
      );
    }

    // Step 2: transfer. No authorization header: the signature in the URL is the credential.
    await putPresigned(reservation.data.upload_url, bytes, {
      "Content-Type": contentType,
      ...(reservation.data.headers ?? {}),
    });

    // Step 3: register. Until this lands the object is swept and is not part of the library.
    const asset = await apiRequest<Record<string, unknown>>({
      method: "POST",
      path: "/media",
      headers: { "Idempotency-Key": randomUUID() },
      body: {
        upload_id: reservation.data.upload_id,
        ...(args.alt_text === undefined ? {} : { alt_text: args.alt_text }),
      },
    });

    return text(
      [
        `Uploaded ${fileName} (${bytes.byteLength} bytes) and registered it in the media library.`,
        "",
        JSON.stringify(asset.data, null, 2),
      ].join("\n"),
    );
  } catch (err) {
    return formatApiError(err, { tool: "upload_media", scope: "media:write", entitlement: "none" });
  }
}
