import { z } from "zod";
import {
  ACCEPTED_TYPES,
  MAX_IMAGE_BYTES,
  MediaError,
  contentTypeFor,
  extensionFor,
  fetchImage,
  safeFileName,
  uploadImage,
} from "../api/media.js";
import { forTool, hasKey, keyKindOf, type ToolContext } from "../core/context.js";
import { formatApiError, publishableKeyRefusal, text, toolError, type ToolResult } from "../errors.js";
import type { ToolArgs } from "./call.js";

/**
 * THE ONLY GROUPED TOOL (API-6 §2). Uploading is a three step handshake across two endpoints and
 * a presigned PUT that must carry no authorization header. A model asked to orchestrate that gets
 * it wrong in ways that leave reserved uploads and orphaned objects behind, so the three steps are
 * one tool. Both endpoints it uses are recorded as refusals in the generated table, with this tool
 * named as the reason, so nothing has silently gone missing from the surface.
 *
 * The bytes come from a public `url` or from `base64` in the call, which works on every host. The
 * stdio host also injects `path`, a file on this machine; the tool itself never reads a disk.
 */

/** What a host with a filesystem adds: read a local image. */
export interface LocalFileReader {
  read(path: string): Promise<{ bytes: Uint8Array; fileName: string } | { error: string }>;
}

const NAME = "upload_media";

function inputSchema(withFiles: boolean): Record<string, z.ZodTypeAny> {
  const sources = withFiles ? "Give exactly one of path, url or base64." : "Give exactly one of url or base64.";
  return {
    ...(withFiles
      ? {
          path: z.string().optional().describe(`Absolute path to an image on this machine. ${sources}`),
        }
      : {}),
    url: z.string().optional().describe(`Public https URL to fetch the image from. ${sources}`),
    base64: z
      .string()
      .optional()
      .describe(`The image bytes, base64 encoded, at most 10 MB decoded. Needs filename. ${sources}`),
    filename: z
      .string()
      .optional()
      .describe("The filename to store it under, for example hero.png. Required with base64; taken from the path or URL otherwise."),
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
  };
}

/** The tool as a host registers it. A file reader is what makes `path` appear. */
export function uploadMediaTool(files: LocalFileReader | null) {
  return {
    name: NAME,
    description: `Upload an image to the Site's media library and return the asset with a usable url, which you can then set as an article's featured_image_url. Give it ${files ? "a local file path, a public https url, or the bytes as base64 with a filename" : "a public https url, or the bytes as base64 with a filename"}. It drives the whole three step upload for you: reserve, transfer the bytes, register the asset. Changes content on the customer's Site. Nothing becomes public: an asset is only visible where you attach it. Needs a secret key (wv_sk_) carrying the media:write scope.`,
    scope: "media:write",
    entitlement: "none",
    inputSchema: inputSchema(files !== null),
  };
}

/** The remote-safe definition. */
export const UPLOAD_MEDIA = uploadMediaTool(null);

/** Standard or URL-safe base64, whitespace tolerated, a data: URL prefix stripped. Null when it is not base64. */
export function decodeBase64(input: string): Uint8Array | null {
  const body = input.replace(/^data:[^,]*;base64,/i, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (body.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return null;
  const padded = body.padEnd(Math.ceil(body.length / 4) * 4, "=");
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function handleUploadMedia(ctx: ToolContext, rawArgs: ToolArgs, files: LocalFileReader | null = null): Promise<ToolResult> {
  const args = (rawArgs ?? {}) as {
    path?: string;
    url?: string;
    base64?: string;
    filename?: string;
    content_type?: string;
    alt_text?: string;
    bucket?: string;
  };

  if (!hasKey(ctx)) return toolError(ctx.notSignedIn());
  if (keyKindOf(ctx) === "publishable") return publishableKeyRefusal(NAME, "media:write");

  const path = files && args.path ? args.path : undefined;
  const given = [path, args.url, args.base64].filter((v) => typeof v === "string" && v.length > 0).length;
  const choices = files ? "path (a local file), url (a public https URL) or base64 with filename" : "url (a public https URL) or base64 with filename";
  if (given === 0) return toolError(`upload_media needs one of ${choices}.`);
  if (given > 1) return toolError(`upload_media takes one of ${choices}, not several.`);

  let bytes: Uint8Array;
  let derivedName: string;
  let fetchedType: string | undefined;

  if (path) {
    const read = await files!.read(path);
    if ("error" in read) return toolError(read.error);
    bytes = read.bytes;
    derivedName = read.fileName;
  } else if (args.base64) {
    if (!args.filename) return toolError("upload_media needs filename with base64, for example hero.png, so the image is stored under a sensible name.");
    const decoded = decodeBase64(args.base64);
    if (!decoded || decoded.byteLength === 0) return toolError("base64 is not valid base64 image data.");
    if (decoded.byteLength > MAX_IMAGE_BYTES) {
      return toolError(`The image is ${decoded.byteLength} bytes and the limit is ${MAX_IMAGE_BYTES}. Resize it and try again.`);
    }
    bytes = decoded;
    derivedName = args.filename;
  } else {
    try {
      const fetched = await fetchImage(args.url as string);
      bytes = fetched.bytes;
      derivedName = fetched.fileName;
      fetchedType = fetched.contentType;
    } catch (err) {
      return toolError(`Could not fetch url: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  let fileName = safeFileName(args.filename ?? derivedName);
  const contentType = args.content_type ?? contentTypeFor(fileName) ?? fetchedType;
  if (!contentType) {
    return toolError(
      `Cannot tell what kind of image ${fileName} is. Pass content_type explicitly. Accepted: ${ACCEPTED_TYPES.join(", ")}.`,
    );
  }
  if (!contentTypeFor(fileName) && extensionFor(contentType)) fileName = `${fileName}.${extensionFor(contentType)}`;

  try {
    const asset = await uploadImage(forTool(ctx, NAME), {
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
    return formatApiError(err, { tool: NAME, scope: "media:write", entitlement: "none" });
  }
}
