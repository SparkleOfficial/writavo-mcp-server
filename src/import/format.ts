import { z } from "zod/v4";

/**
 * WRITAVO IMPORT FORMAT v1. Defined once, here, in zod; the JSON Schema published to agents is
 * emitted from this definition (importFormatJsonSchema) rather than written beside it, so the
 * validator and the documentation cannot disagree.
 *
 * zod/v4 rather than the zod v3 the tool schemas use, because v4 is the one that can emit JSON
 * Schema. The two never meet: this schema parses a file, it is not a tool's input schema.
 *
 * The limits mirror the API's (openapi.yaml ArticleCreate, TaxonomyTermWrite, AuthorWrite), so a
 * dry run refuses what the API would refuse, before anything is written.
 */

export const IMPORT_FORMAT_NAME = "writavo-import";
export const IMPORT_FORMAT_VERSION = 1;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 1 to 255 printable ASCII characters, no spaces. The same rule as articles.external_id. */
export const EXTERNAL_ID_PATTERN = /^[\x21-\x7E]{1,255}$/;

export const LIMITS = {
  title: 300,
  slug: 200,
  excerpt: 1000,
  seoTitle: 200,
  seoDescription: 400,
  url: 2048,
  termName: 120,
  termSlug: 120,
  authorRef: 120,
  authorName: 160,
  bio: 2000,
  alt: 500,
} as const;

const SLUG_RULE = "lowercase letters, digits and single hyphens, for example my-first-post";

const slug = (max: number) => z.string().max(max).regex(SLUG_PATTERN, `must be ${SLUG_RULE}`);
const url = z.string().min(1).max(LIMITS.url).regex(/^https?:\/\/\S+$/i, "must be an absolute http(s) URL");
const dateTime = z.iso.datetime({
  offset: true,
  error: (issue) =>
    issue.input === undefined
      ? "is required"
      : "must be an ISO 8601 date and time with a timezone, for example 2021-03-04T09:30:00Z",
});
const text = (max?: number) => (max ? z.string().max(max) : z.string());

export const FaqSchema = z.strictObject({
  question: z.string().min(1),
  answer: z.string().min(1),
});

export const HowtoStepSchema = z.strictObject({
  name: z.string().min(1),
  text: z.string().optional(),
  image_url: url.optional(),
});

export const ComparisonSchema = z.strictObject({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

export const FeaturedImageSchema = z.strictObject({
  url,
  alt: z.string().max(LIMITS.alt).optional(),
});

export const AuthorSchema = z.strictObject({
  ref: z.string().min(1).max(LIMITS.authorRef).describe("Your own handle for this author, used by articles[].author."),
  name: z.string().min(1).max(LIMITS.authorName).describe("Matched against the Site's authors by exact name; created if missing."),
  bio: text(LIMITS.bio).nullable().optional(),
  avatar_url: url.nullable().optional(),
  is_ai_generated: z.boolean().optional().describe("False (the default) for a real person."),
});

export const TermSchema = z.strictObject({
  slug: slug(LIMITS.termSlug).describe("Matched against the Site by slug; created if missing."),
  name: z.string().min(1).max(LIMITS.termName),
});

/** Fields shared by drafts and published articles. */
const articleFields = {
  external_id: z
    .string()
    .regex(EXTERNAL_ID_PATTERN, "must be 1 to 255 printable ASCII characters with no spaces")
    .describe("Your stable id for this article in the source system, for example blog:1234. Re-running an import updates the article with this id rather than creating a second one."),
  title: text(LIMITS.title).nullable().optional(),
  slug: slug(LIMITS.slug).nullable().optional().describe("Keep the source slug exactly, so the URL does not change."),
  content: z.string().nullable().optional().describe("The body, in markdown."),
  excerpt: text(LIMITS.excerpt).nullable().optional(),
  seo_title: text(LIMITS.seoTitle).nullable().optional(),
  seo_description: text(LIMITS.seoDescription).nullable().optional(),
  seo_keywords: z.array(z.string()).nullable().optional(),
  featured_image: FeaturedImageSchema.nullable().optional(),
  faqs: z.array(FaqSchema).nullable().optional(),
  key_takeaways: z.array(z.string()).nullable().optional(),
  howto_steps: z.array(HowtoStepSchema).nullable().optional(),
  comparison: ComparisonSchema.nullable().optional(),
  author: z.string().min(1).optional().describe("An authors[].ref."),
  category: z.string().min(1).optional().describe("A categories[].slug, or the slug of a category already on the Site."),
  tags: z.array(z.string().min(1)).optional().describe("tags[].slug values, or slugs of tags already on the Site."),
  format: z.string().min(1).optional().describe("A content type key on the Site, for example how_to. Optional."),
  published_at: dateTime.optional().describe("When the article was FIRST published at the source."),
  content_updated_at: dateTime.optional().describe("When its content last changed at the source. Not before published_at."),
};

export const PublishedArticleSchema = z.strictObject({
  ...articleFields,
  status: z.literal("published"),
  title: z.string().min(1, "a published article needs a title").max(LIMITS.title),
  slug: slug(LIMITS.slug).describe("Required for a published article. Keep the source slug exactly."),
  content: z.string().min(1, "a published article needs content"),
  published_at: dateTime.describe("Required for a published article: its ORIGINAL first publication date, in the past."),
});

export const DraftArticleSchema = z.strictObject({
  ...articleFields,
  status: z.literal("draft"),
});

export const ImportArticleSchema = z.discriminatedUnion("status", [PublishedArticleSchema, DraftArticleSchema]);

const documentFields = {
  format: z.literal(IMPORT_FORMAT_NAME),
  version: z.literal(IMPORT_FORMAT_VERSION),
  source: z
    .strictObject({
      name: z.string().max(200).optional(),
      url: z.string().max(LIMITS.url).optional(),
    })
    .optional()
    .describe("Informational only."),
  authors: z.array(AuthorSchema).optional(),
  categories: z.array(TermSchema).optional(),
  tags: z.array(TermSchema).optional(),
};

export const ImportDocumentSchema = z
  .strictObject({
    ...documentFields,
    articles: z.array(ImportArticleSchema).min(1).describe("Processed in file order."),
  })
  .describe("Writavo Import Format v1: a blog's articles, authors, categories and tags, for import_content.");

/**
 * The same document with the articles left unparsed, so one bad article is reported against its
 * own external_id instead of failing the whole file.
 */
export const ImportEnvelopeSchema = z.strictObject({
  ...documentFields,
  articles: z.array(z.unknown()).min(1),
});

export type ImportDocument = z.infer<typeof ImportDocumentSchema>;
export type ImportArticle = z.infer<typeof ImportArticleSchema>;
export type ImportEnvelope = z.infer<typeof ImportEnvelopeSchema>;
export type ImportAuthor = z.infer<typeof AuthorSchema>;
export type ImportTerm = z.infer<typeof TermSchema>;

export const IMPORT_FORMAT_SCHEMA_ID = "https://writavo.com/schemas/import-v1.json";

/** The JSON Schema, emitted from the zod definition above. */
export function importFormatJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ImportDocumentSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return { ...schema, $id: IMPORT_FORMAT_SCHEMA_ID, title: "Writavo Import Format v1" };
}

/** A small valid document, for documentation and for the smoke test. */
export const IMPORT_SAMPLE: ImportDocument = {
  format: "writavo-import",
  version: 1,
  source: { name: "Old blog", url: "https://example.com" },
  authors: [{ ref: "jane", name: "Jane Doe", bio: "Writes about gardening.", is_ai_generated: false }],
  categories: [{ slug: "guides", name: "Guides" }],
  tags: [{ slug: "soil", name: "Soil" }],
  articles: [
    {
      external_id: "blog:1001",
      status: "published",
      title: "How to test your soil",
      slug: "how-to-test-your-soil",
      content: "Good gardens start underground.\n\n![A soil test kit](https://example.com/images/kit.jpg)\n\n## What you need\n\nA jar, water and a day.",
      excerpt: "A simple jar test tells you most of what a lab would.",
      featured_image: { url: "https://example.com/images/soil.jpg", alt: "A handful of dark soil" },
      author: "jane",
      category: "guides",
      tags: ["soil"],
      published_at: "2021-03-04T09:30:00Z",
      content_updated_at: "2022-01-10T12:00:00Z",
    },
    {
      external_id: "blog:1002",
      status: "draft",
      title: "Composting in winter",
      content: "Unfinished notes.",
      author: "jane",
    },
  ],
};

/** The field guide, shared by the import-format resource, import_content and the migrate prompt. */
export const IMPORT_FORMAT_GUIDE = `# Writavo Import Format v1

A single JSON file describing a blog's articles, authors, categories and tags. import_content reads
it, checks it against the Site in a dry run, and then imports it in batches. Re-running an import
is safe: articles are matched by external_id, so a second run updates rather than duplicates.

Top level:
- format: always "writavo-import". version: always 1.
- source: optional, informational ({ name, url }).
- authors: [{ ref, name, bio?, avatar_url?, is_ai_generated? }]. ref is your own handle, used by
  articles[].author. Authors are matched on the Site by exact name and created when missing.
  is_ai_generated defaults to false, which is right for a real person.
- categories: [{ slug, name }] and tags: [{ slug, name }]. Matched on the Site by slug, created
  when missing. Slugs are ${SLUG_RULE}, at most ${LIMITS.termSlug} characters.
- articles: processed in file order. Each one:
  - external_id (required): your stable id from the source system, for example "blog:1234".
    1 to 255 printable ASCII characters. Never reuse one for a different article.
  - status (required): "published" or "draft". A published article is published on the Site
    with its ORIGINAL dates. A draft stays a draft. Leave out anything unfinished or scraped.
  - title (max ${LIMITS.title}), slug (max ${LIMITS.slug}), content (markdown). All three are
    required when status is "published". Keep the slug exactly as it is at the source, so the
    URL does not change.
  - excerpt (max ${LIMITS.excerpt}), seo_title (max ${LIMITS.seoTitle}), seo_description
    (max ${LIMITS.seoDescription}), seo_keywords (array of strings).
  - featured_image: { url, alt? }.
  - faqs: [{ question, answer }], key_takeaways: [string], howto_steps: [{ name, text?,
    image_url? }], comparison: { headers: [string], rows: [[string]] }.
  - author: an authors[].ref. category: a category slug. tags: tag slugs.
  - format: a content type key on the Site (see get_content_types). Optional.
  - published_at: required when published. When the article was FIRST published at the source,
    ISO 8601 with a timezone, in the past, not before 1990.
  - content_updated_at: optional. When its content last changed. Not before published_at.

Images: inline markdown images ![alt](https://...), featured images, how-to step images and
author avatars are copied into the Site's media library and the URLs rewritten, unless
rehost_images is false. Only https images are copied, up to 10 MB each; anything else keeps its
original URL and is reported. Nothing else in the content is changed.

Unknown fields are refused rather than ignored, so a misnamed field (body instead of content)
is caught in the dry run instead of silently dropped.
`;

/** The guide, a sample and the JSON Schema in one markdown document: what an agent reads first. */
export function importFormatDocument(): string {
  return [
    IMPORT_FORMAT_GUIDE,
    "## Sample document",
    "",
    "```json",
    JSON.stringify(IMPORT_SAMPLE, null, 2),
    "```",
    "",
    "## JSON Schema",
    "",
    "```json",
    JSON.stringify(importFormatJsonSchema(), null, 2),
    "```",
  ].join("\n");
}
