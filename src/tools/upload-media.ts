import { readFile } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { ACCEPTED_TYPES, MediaError, contentTypeFor, fetchImage, uploadImage } from "../api/media.js";
import { hasApiKey, keyKind, noKeyMessage } from "../config.js";
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

export async function handleUploadMedia(rawArgs: ToolArgs): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as {
    file_path?: string;
    source_url?: string;
    file_name?: string;
    content_type?: string;
    alt_text?: string;
    bucket?: string;
  };

  if (!hasApiKey()) return toolError(noKeyMessage());
  if (keyKind() === "publishable") return publishableKeyRefusal("upload_media", "media:write");

  if (!args.file_path && !args.source_url) {
    return toolError("upload_media needs either file_path (a local file) or source_url (a public https URL).");
  }
  if (args.file_path && args.source_url) {
    return toolError("upload_media takes file_path or source_url, not both.");
  }

  let bytes: Uint8Array;
  let derivedName: string;
  let fetchedType: string | undefined;

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
    try {
      const fetched = await fetchImage(args.source_url as string);
      bytes = fetched.bytes;
      derivedName = fetched.fileName;
      fetchedType = fetched.contentType;
    } catch (err) {
      return toolError(`Could not fetch source_url: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  const fileName = args.file_name ?? derivedName;
  const contentType = args.content_type ?? contentTypeFor(fileName) ?? fetchedType;
  if (!contentType) {
    return toolError(
      `Cannot tell what kind of image ${fileName} is. Pass content_type explicitly. Accepted: ${ACCEPTED_TYPES.join(", ")}.`,
    );
  }

  try {
    const asset = await uploadImage({
      bytes,
      fileName,
      contentType,
      altText: args.alt_text,
      bucket: args.bucket as "blog-images" | "author-avatars" | undefined,
    });
    return text(
      [
        `Uploaded ${fileName} (${bytes.byteLength} bytes) and registered it in the media library.`,
        "",
        JSON.stringify(asset, null, 2),
      ].join("\n"),
    );
  } catch (err) {
    if (err instanceof MediaError) return toolError(`upload_media failed: ${err.message}`);
    return formatApiError(err, { tool: "upload_media", scope: "media:write", entitlement: "none" });
  }
}
