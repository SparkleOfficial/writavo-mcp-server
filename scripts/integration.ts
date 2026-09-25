/**
 * Writavo MCP server, live round trip. API-6 acceptance test 3.
 * =================================================================================
 *
 * Against a real Site with a real secret key: create an article, set its category and author,
 * upload and attach an image, publish it, read it back, unpublish it, then delete it. All through
 * the same tool handlers an MCP client calls, so what passes here is what an assistant does.
 *
 *   WRITAVO_API_KEY=wv_sk_... pnpm --filter @writavo/mcp-server integration
 *
 * USE A SCRATCH SITE. It publishes an article to whatever Site the key belongs to, which is a
 * public page on a real domain for the few seconds before it unpublishes it again. It cleans up
 * after itself, including on failure, but a key for a customer's live Site is the wrong key here.
 *
 * The offline half of the acceptance tests is scripts/smoke.ts and needs nothing.
 */

import { deflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.WRITAVO_API_KEY ?? "";
if (!KEY.startsWith("wv_sk_")) {
  console.error(
    [
      "This needs a real secret key for a scratch Site.",
      "",
      "  WRITAVO_API_KEY=wv_sk_... pnpm --filter @writavo/mcp-server integration",
      "",
      "Create one at https://app.writavo.com/settings/api-keys with the scopes:",
      "  articles:write, taxonomy:read, authors:read, media:write, meta:read",
    ].join("\n"),
  );
  process.exit(2);
}

const { callOperation } = await import("../src/tools/call.js");
const { handleUploadMedia } = await import("../src/tools/upload-media.js");
const { STDIO_CONTEXT } = await import("../src/stdio/context.js");
const { MEDIA_FILES } = await import("../src/stdio/files.js");
const { OPERATIONS } = await import("../src/generated/operations.js");

interface ToolReply {
  content?: { text?: string }[];
  isError?: boolean;
}

const checks: { name: string; ok: boolean; detail: string }[] = [];
const body = (r: ToolReply): string => (r.content ?? []).map((c) => c.text ?? "").join("\n");

function operation(tool: string) {
  const found = OPERATIONS.find((o) => o.tool === tool);
  if (!found) throw new Error(`no generated operation for ${tool}`);
  return found;
}

async function step(
  name: string,
  run: () => Promise<ToolReply>,
  expect: (r: ToolReply) => string | null,
): Promise<ToolReply> {
  const started = Date.now();
  let reply: ToolReply;
  try {
    reply = await run();
  } catch (err) {
    checks.push({ name, ok: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` });
    console.log(`  FAIL  ${name}`);
    return { isError: true };
  }
  const problem = expect(reply);
  checks.push({ name, ok: problem === null, detail: problem ?? "" });
  console.log(`  ${problem === null ? "ok  " : "FAIL"}  ${name} (${Date.now() - started}ms)`);
  if (problem) console.log(`        ${problem}\n        ${body(reply).slice(0, 400)}`);
  return reply;
}

const succeeds = (r: ToolReply): string | null => (r.isError ? "returned an error" : null);
const json = (r: ToolReply): Record<string, unknown> => {
  const at = body(r).indexOf("{");
  return at === -1 ? {} : (JSON.parse(body(r).slice(at)) as Record<string, unknown>);
};

/** A real 64x64 PNG, built here so the test needs no fixture file and no image library. */
function tinyPng(): Buffer {
  const width = 64;
  const height = 64;
  const raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 4) % 256;
      raw[row + 2 + x * 3] = (y * 4) % 256;
      raw[row + 3 + x * 3] = 128;
    }
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main(): Promise<void> {
  console.log("================================================");
  console.log("  Writavo MCP server, live round trip");
  console.log("================================================\n");

  const stamp = Date.now();
  const slug = `mcp-integration-${stamp}`;
  let articleId: string | null = null;
  const workDir = mkdtempSync(join(tmpdir(), "writavo-mcp-"));

  try {
    console.log("[ Connect ]");
    await step("verify_api_key", () => callOperation(STDIO_CONTEXT, operation("verify_api_key"), {}), (r) =>
      body(r).includes("secret") ? null : "the key did not report as secret",
    );
    await step("get_site_info", () => callOperation(STDIO_CONTEXT, operation("get_site_info"), {}), succeeds);

    console.log("\n[ Taxonomy and people ]");
    const categories = await step(
      "list_categories",
      () => callOperation(STDIO_CONTEXT, operation("list_categories"), { limit: 5 }),
      succeeds,
    );
    const authors = await step("list_authors", () => callOperation(STDIO_CONTEXT, operation("list_authors"), { limit: 5 }), succeeds);
    const categoryId = (json(categories).items as { id: string }[] | undefined)?.[0]?.id ?? null;
    const authorId = (json(authors).items as { id: string }[] | undefined)?.[0]?.id ?? null;

    console.log("\n[ Create ]");
    const created = await step(
      "create_article creates a DRAFT",
      () =>
        callOperation(STDIO_CONTEXT, operation("create_article"), {
          title: `MCP integration ${stamp}`,
          slug,
          content:
            "## This article was created by the integration test\n\nIt exists for a few seconds and is then deleted. If you are reading it on a live site, the test did not finish.",
          excerpt: "A throwaway article created by the Writavo MCP integration test.",
          seo_title: `MCP integration ${stamp}`,
          seo_description: "A throwaway article created by the Writavo MCP integration test.",
        }),
      (r) => {
        if (r.isError) return "returned an error";
        const data = json(r);
        articleId = typeof data.id === "string" ? data.id : null;
        if (!articleId) return "no article id in the reply";
        return data.status === "draft" ? null : `created at status ${String(data.status)}, expected draft`;
      },
    );
    if (!articleId) throw new Error(`cannot continue without an article id: ${body(created).slice(0, 200)}`);

    console.log("\n[ Organise ]");
    if (categoryId || authorId) {
      await step(
        "update_article sets the category and author",
        () =>
          callOperation(STDIO_CONTEXT, operation("update_article"), {
            id: articleId,
            ...(categoryId ? { category_id: categoryId } : {}),
            ...(authorId ? { author_id: authorId } : {}),
          }),
        succeeds,
      );
    } else {
      console.log("  skip  the Site has no categories or authors to attach");
    }

    console.log("\n[ Media ]");
    const imagePath = join(workDir, `mcp-integration-${stamp}.png`);
    writeFileSync(imagePath, tinyPng());
    const uploaded = await step(
      "upload_media drives the whole three step upload",
      () => handleUploadMedia(STDIO_CONTEXT, { path: imagePath, alt_text: "A test gradient." }, MEDIA_FILES),
      succeeds,
    );
    const imageUrl = json(uploaded).url;
    if (typeof imageUrl === "string") {
      await step(
        "update_article attaches the image",
        () => callOperation(STDIO_CONTEXT, operation("update_article"), { id: articleId, featured_image_url: imageUrl }),
        succeeds,
      );
    }

    console.log("\n[ Publish ]");
    await step(
      "publish_article refuses without confirmation",
      () => callOperation(STDIO_CONTEXT, operation("publish_article"), { id: articleId }),
      (r) => (body(r).startsWith("Nothing has been done.") ? null : "it did not refuse"),
    );
    await step(
      "publish_article publishes once confirmed",
      () => callOperation(STDIO_CONTEXT, operation("publish_article"), { id: articleId, confirm: true }),
      (r) => (json(r).status === "published" ? null : `status is ${String(json(r).status)}`),
    );

    console.log("\n[ Read back ]");
    await step(
      "get_article returns it as published",
      () => callOperation(STDIO_CONTEXT, operation("get_article"), { id: articleId }),
      (r) => (json(r).status === "published" ? null : `status is ${String(json(r).status)}`),
    );
    await step(
      "list_articles finds it by slug",
      () => callOperation(STDIO_CONTEXT, operation("list_articles"), { slug, status: ["published"] }),
      (r) => {
        const items = json(r).items as { id: string }[] | undefined;
        return items?.some((i) => i.id === articleId) ? null : "the published list does not contain it";
      },
    );

    console.log("\n[ Unpublish ]");
    await step(
      "unpublish_article takes it off the web",
      () => callOperation(STDIO_CONTEXT, operation("unpublish_article"), { id: articleId }),
      (r) => (json(r).status === "draft" ? null : `status is ${String(json(r).status)}`),
    );
  } finally {
    if (articleId) {
      console.log("\n[ Clean up ]");
      await step(
        "delete_article removes the test article",
        () => callOperation(STDIO_CONTEXT, operation("delete_article"), { id: articleId, confirm: true }),
        succeeds,
      );
    }
    rmSync(workDir, { recursive: true, force: true });
  }

  console.log("\n================================================");
  const failed = checks.filter((c) => !c.ok);
  console.log(`  ${checks.length - failed.length} passed, ${failed.length} failed, ${checks.length} total`);
  console.log("================================================");
  if (failed.length > 0) process.exit(1);
}

main().catch((err: unknown) => {
  console.error("the integration runner crashed:", err);
  process.exit(2);
});
