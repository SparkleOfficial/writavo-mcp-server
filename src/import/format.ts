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
  authorSlug: 120,
  jobTitle: 160,
  bio: 2000,
  termDescription: 2000,
  groupLabel: 80,
  howtoName: 300,
  howtoDescription: 2000,
  comparisonTitle: 300,
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

/** A how-to: either the bare list of steps, or the list with the how-to's own name and summary
 *  (the shape Writavo stores, and schema.org HowTo's name and description). */
export const HowtoSchema = z.union([
  z.array(HowtoStepSchema),
  z.strictObject({
    name: text(LIMITS.howtoName).optional().describe("The how-to's own title, for example How to transcribe a podcast."),
    description: text(LIMITS.howtoDescription).optional().describe("A one or two sentence summary of the how-to."),
    steps: z.array(HowtoStepSchema),
  }),
]);

export type ImportHowto = z.infer<typeof HowtoSchema>;

/** The steps of either how-to form. */
export const howtoSteps = (h: ImportHowto | null | undefined): z.infer<typeof HowtoStepSchema>[] =>
  !h ? [] : Array.isArray(h) ? h : h.steps;

export const ComparisonSchema = z.strictObject({
  title: text(LIMITS.comparisonTitle).optional().describe("The table's own heading, shown above it."),
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});

/** Where the article came from (0120), kept private: never shown on the public blog. With the
 *  source page's text, Writavo measures how original the article is itself; without it, an
 *  originality_pct from the old system is kept as reported, not measured. */
export const ArticleSourceSchema = z.strictObject({
  url: url.describe("The page the article was written from."),
  title: text(500).nullable().optional(),
  competitor: text(253).nullable().optional().describe("The competitor's domain, matched to the Site's competitors."),
  content: text(80_000).nullable().optional().describe("The source page's text. Lets Writavo measure originality."),
  originality_pct: z.number().min(0).max(100).nullable().optional().describe("The old system's own originality figure, kept as reported."),
  target_keywords: z.array(z.string().max(200)).max(50).optional(),
  metrics: z
    .strictObject({
      seo_score: z.number().min(0).nullable().optional(),
      organic_traffic: z.number().min(0).nullable().optional(),
      backlinks: z.number().min(0).nullable().optional(),
      referring_domains: z.number().min(0).nullable().optional(),
      ranking_keywords: z.number().min(0).nullable().optional(),
      top10_keywords: z.number().min(0).nullable().optional(),
    })
    .optional()
    .describe("The source page's SEO strength when it was chosen."),
});

export const FeaturedImageSchema = z.strictObject({
  url,
  alt: z.string().max(LIMITS.alt).optional(),
});

/** The API's author_type values (0095). A byline label a theme groups on; it grants nothing. */
export const AUTHOR_TYPES = ["co-founder", "admin", "user"] as const;

/** The networks the API accepts in an author's socials. Mirrors AUTHOR_SOCIAL_NETWORKS in
 *  supabase/functions/_shared/apiProjections.ts, so a dry run refuses what the API would. */
export const AUTHOR_SOCIAL_NETWORKS = [
  "website", "x", "linkedin", "github", "youtube", "instagram", "facebook", "mastodon", "bluesky",
  "threads", "tiktok",
] as const;

export const AuthorSchema = z.strictObject({
  ref: z.string().min(1).max(LIMITS.authorRef).describe("Your own handle for this author, used by articles[].author."),
  name: z.string().min(1).max(LIMITS.authorName).describe("Matched against the Site's authors by slug when given, else by exact name; created if missing."),
  slug: slug(LIMITS.authorSlug).optional().describe("The author's URL key at the source. Matched first; used when the author is created."),
  bio: text(LIMITS.bio).nullable().optional(),
  avatar_url: url.nullable().optional(),
  job_title: text(LIMITS.jobTitle).nullable().optional().describe("Rendered as the schema.org Person jobTitle."),
  socials: z
    .partialRecord(z.enum(AUTHOR_SOCIAL_NETWORKS), url)
    .optional()
    .describe("Profile links by network, rendered as schema.org sameAs."),
  author_type: z.enum(AUTHOR_TYPES).optional().describe("A byline label a theme can group on (a founders page). Defaults to user."),
  is_ai_generated: z.boolean().optional().describe("False (the default) for a real person."),
});

const termFields = {
  slug: slug(LIMITS.termSlug).describe("Matched against the Site by slug; created if missing."),
  name: z.string().min(1).max(LIMITS.termName),
  description: text(LIMITS.termDescription).nullable().optional().describe("Shown on the archive page. Filled on an existing term only when it has none."),
  is_active: z.boolean().optional().describe("false imports it archived: kept, but hidden on the public blog and from the AI. Only applied when the term is created."),
};

export const CategorySchema = z.strictObject({
  ...termFields,
  parent: slug(LIMITS.termSlug)
    .optional()
    .describe("The parent category's slug (in this file or on the Site), for a nested category. Set on an existing category only when it has no parent."),
});

export const TagSchema = z.strictObject({
  ...termFields,
  group_label: text(LIMITS.groupLabel).nullable().optional().describe("A label a theme can group tags under. Filled on an existing tag only when it has none."),
});

/** A category or a tag, as the engine handles both. */
export const TermSchema = TagSchema;

/** Fields shared by drafts and published articles. */
/**
 * What producing the article cost in the old system (its API spend), for the record. Stored apart
 * from Writavo's own cost ledger: never billed, never counted against a spend cap.
 */
export const CostEntrySchema = z.strictObject({
  cost_usd: z.number().min(0).max(100_000).describe("What this cost, in US dollars."),
  stage: text(60).optional().describe("A label for what it paid for: research, generate, images..."),
  provider: text(60).optional().describe("Who was paid: openai, dataforseo..."),
  calls: z.number().int().min(0).optional(),
  tokens: z.number().int().min(0).optional(),
  occurred_on: z.iso.date({ error: "must be a date, YYYY-MM-DD" }).optional(),
  description: text(500).optional(),
});
export type CostEntry = z.infer<typeof CostEntrySchema>;

const articleFields = {
  external_id: z
    .string()
    .regex(EXTERNAL_ID_PATTERN, "must be 1 to 255 printable ASCII characters with no spaces")
    .describe("Your stable id for this article in the source system, for example blog:1234. Re-running an import updates the article with this id rather than creating a second one."),
  kind: z
    .enum(["article", "page"])
    .optional()
    .describe("page for a page such as About or Contact (no byline or date, not listed with the posts); article (the default) for a post."),
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
  howto_steps: HowtoSchema.nullable().optional(),
  comparison: ComparisonSchema.nullable().optional(),
  author: z.string().min(1).optional().describe("An authors[].ref."),
  category: z.string().min(1).optional().describe("The PRIMARY category: a categories[].slug, or the slug of a category already on the Site."),
  categories: z
    .array(z.string().min(1))
    .max(19)
    .optional()
    .describe("Every OTHER category the article is filed under (slugs), when it is in several. The primary goes in category."),
  tags: z.array(z.string().min(1)).optional().describe("tags[].slug values, or slugs of tags already on the Site."),
  format: z.string().min(1).optional().describe("A content type key on the Site, for example how_to. Optional."),
  source: ArticleSourceSchema.nullable().optional().describe("Where the article came from. Private."),
  cost_history: z
    .array(CostEntrySchema)
    .max(500)
    .optional()
    .describe("What producing it cost in the old system, for the record: shown beside Writavo's own costs, never billed or counted against a spend cap. Replaces any cost history imported for it before."),
  published_at: dateTime.optional().describe("When the article was FIRST published at the source."),
  content_updated_at: dateTime.optional().describe("When its content last changed at the source. Not before published_at."),
  old_urls: z
    .array(z.string().min(1).max(LIMITS.url))
    .max(20)
    .optional()
    .describe("Every URL the article was reachable at in the old system: its permalink (https://example.com/2021/03/my-post/), its ?p=123 link, older permalinks. Each answers with a 301 to the article on the Writavo blog once it is published."),
  // The per-article SEO overrides (API 0128): what Yoast or Rank Math kept for the post. Leave a
  // field out when the old system derived it; the blog then derives it the same way.
  canonical_url: url
    .nullable()
    .optional()
    .describe("Only when the post's canonical pointed somewhere other than its own URL (a syndicated post). Leave it out otherwise."),
  noindex: z.boolean().optional().describe("true when the post was hidden from search engines. It stays on the blog but leaves the sitemap."),
  og_title: text(LIMITS.seoTitle).nullable().optional().describe("The social-share title, when it differed from the SEO title."),
  og_description: text(LIMITS.seoDescription).nullable().optional().describe("The social-share description, when it differed from the meta description."),
  og_image: FeaturedImageSchema.nullable()
    .optional()
    .describe("The social-share image, when it differed from the featured image. Copied into the media library like every other image."),
  custom_fields: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      "Values of the Site's custom article fields (the content type `article`), keyed by field API id. References and media are portable values ($ref, $media), as in entries[].data. Applied after every article and entry exists.",
    ),
};

// ---------------------------------------------------------------------------
// Redirects (optional): old URLs that are not an article's (archives, pages, feeds)
// ---------------------------------------------------------------------------

export const RedirectEntrySchema = z
  .strictObject({
    from: z.string().min(1).max(LIMITS.url).describe("The old URL: a full URL (https://example.com/category/guides/) or a path under the blog."),
    to: z.string().min(1).max(LIMITS.url).optional().describe("Where it goes now: a path under the blog (/category/guides) or a full https URL."),
    to_external_id: z
      .string()
      .regex(EXTERNAL_ID_PATTERN, "must be 1 to 255 printable ASCII characters with no spaces")
      .optional()
      .describe("Or the article it goes to, by external_id (in this document or already on the Site)."),
    status: z.union([z.literal(301), z.literal(302)]).optional().describe("301 permanent (default) or 302 temporary."),
    note: text(500).optional(),
  })
  .refine((r) => (r.to === undefined) !== (r.to_external_id === undefined), {
    message: "give exactly one of to or to_external_id",
    path: ["to"],
  });
export type RedirectEntry = z.infer<typeof RedirectEntrySchema>;

// ---------------------------------------------------------------------------
// Engagement history (optional): the old blog's per-post views, reactions and shares
// ---------------------------------------------------------------------------

/** Writavo's six reactions and four share platforms (0106): the only values the API accepts. */
export const ENGAGEMENT_REACTIONS = ["useful", "mind_blown", "insightful", "skeptical", "loved", "hot_take"] as const;
export const SHARE_PLATFORMS = ["x", "linkedin", "facebook", "other"] as const;

const engagementCount = z.number().int().min(0).max(10_000_000);
const postKey = {
  external_id: z.string().regex(EXTERNAL_ID_PATTERN, "must be 1 to 255 printable ASCII characters with no spaces").optional().describe("The article's external_id (from articles[] or already on the Site)."),
  slug: slug(LIMITS.slug).optional().describe("Or the article's slug on the Site."),
};
const onePostKey = (row: { external_id?: string; slug?: string }) => (row.external_id === undefined) !== (row.slug === undefined);
const ONE_POST_KEY = { message: "give exactly one of external_id or slug", path: ["external_id"] };

export const EngagementDailySchema = z
  .strictObject({
    ...postKey,
    day: z.iso.date({ error: "must be a date, YYYY-MM-DD (UTC)" }).describe("The UTC day: any finished day (not today, which is counted live)."),
    views: engagementCount.optional(),
    reactions: z
      .union([engagementCount, z.strictObject(Object.fromEntries(ENGAGEMENT_REACTIONS.map((r) => [r, engagementCount.optional()])))])
      .optional()
      .describe("That day's reactions: a number, or per type (Writavo keeps the day's total; the per-type counts come from reactions[])."),
    shares: z.strictObject(Object.fromEntries(SHARE_PLATFORMS.map((p) => [p, engagementCount.optional()]))).optional(),
  })
  .refine(onePostKey, ONE_POST_KEY);

export const EngagementReactionSchema = z
  .strictObject({
    ...postKey,
    visitor_id: z.string().min(1).max(200).describe("The visitor's anonymous id at the old blog. Hashed by Writavo, never stored raw."),
    reaction: z.enum(ENGAGEMENT_REACTIONS),
    set_at: dateTime.describe("When the visitor made this pick."),
  })
  .refine(onePostKey, ONE_POST_KEY);

const ENGAGEMENT_DESCRIPTION =
  "Optional engagement history (views, reactions, shares per post). Imported after every article; each row SETS the totals for its post and day (replacing whatever that day held), so re-running never double-counts. Any finished day; not today, which is counted live.";

/** The section as documented (the JSON Schema): every row typed. */
export const EngagementSchema = z
  .strictObject({
    daily: z.array(EngagementDailySchema).optional().describe("Per post per day: views, reactions, shares."),
    reactions: z.array(EngagementReactionSchema).optional().describe("Each visitor's current reaction per post."),
  })
  .describe(ENGAGEMENT_DESCRIPTION);

/** The section as parsed: rows left unparsed, so each is checked (and reported) on its own. */
export const EngagementEnvelopeSchema = z.strictObject({
  daily: z.array(z.unknown()).optional(),
  reactions: z.array(z.unknown()).optional(),
});

export type EngagementDaily = z.infer<typeof EngagementDailySchema>;
export type EngagementReaction = z.infer<typeof EngagementReactionSchema>;

/**
 * Written by Writavo, not by hand: what a native conversion (a WordPress export) decided, shown in
 * the dry run beside the articles it concerns. Informational; nothing is imported from it.
 */
export const ConversionSchema = z
  .strictObject({
    from: z.enum(["wordpress-wxr", "wordpress-rest"]),
    lines: z.array(z.string().max(2000)).max(50),
    items: z.record(z.string(), z.array(z.string().max(2000)).max(50)),
  })
  .describe("Written by Writavo when it converts a WordPress export: the conversion's report. Leave it out of a document you write yourself.");

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

/** A post that was scheduled at the source: it goes live on Writavo at scheduled_at. */
export const ScheduledArticleSchema = z.strictObject({
  ...articleFields,
  status: z.literal("scheduled"),
  title: z.string().min(1, "a scheduled article needs a title").max(LIMITS.title),
  slug: slug(LIMITS.slug).describe("Required for a scheduled article."),
  content: z.string().min(1, "a scheduled article needs content"),
  scheduled_at: dateTime.describe(
    "When it goes live on the Writavo blog. A time that has already passed when the import runs imports it as a draft instead, with a warning.",
  ),
});

export const ImportArticleSchema = z.discriminatedUnion("status", [PublishedArticleSchema, DraftArticleSchema, ScheduledArticleSchema]);

// ---------------------------------------------------------------------------
// Content types and entries (API 1.5.0, 0136)
// ---------------------------------------------------------------------------
export const API_ID_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** A content type exactly as POST /content-types/apply takes it; the Site's own check (a dry run of
 *  that call) is the authority on the fields, so they are carried here unparsed. */
export const ContentTypeDefSchema = z
  .object({
    api_id: z.string().regex(API_ID_PATTERN, "must be lower-case letters, digits and _, starting with a letter"),
    kind: z.enum(["collection", "singleton", "component", "article_fields"]).optional(),
    name: z.string().min(1).max(80),
    description: z.string().max(500).nullable().optional(),
    title_field: z.string().nullable().optional(),
    fields: z.array(z.record(z.string(), z.unknown())).max(100),
  })
  .describe("A content type as GET /content-types returns it and POST /content-types/apply takes it.");

const entryExternalId = z
  .string()
  .regex(EXTERNAL_ID_PATTERN, "must be 1 to 255 printable ASCII characters with no spaces")
  .describe("Your stable id for the entry. Re-running an import updates the entry with this id rather than creating another.");

export const ImportEntrySchema = z
  .strictObject({
    external_id: entryExternalId,
    type: z.string().regex(API_ID_PATTERN, "must be a content type's API id").describe("The content type's API id (in content_types[] or already on the Site)."),
    slug: slug(LIMITS.slug).nullable().optional(),
    status: z.enum(["draft", "published", "scheduled"]).optional().describe("draft (the default), published, or scheduled with scheduled_at."),
    scheduled_at: dateTime.optional().describe("When a scheduled entry goes live. A time already passed imports it as a draft."),
    unpublish_at: dateTime.optional().describe("When a published entry comes down again (a future time)."),
    data: z
      .record(z.string(), z.unknown())
      .describe(
        'The values, keyed by field API id. A reference is { "$ref": { "type": "<content type, article or page>", "external_id": "..." } } or { "$ref": { "type": "category" | "tag" | "author", "slug": "..." } }; a media value is { "$media": { "url": "https://...", "alt": "..." } }, copied into the media library. Both become ids on the target Site.',
      ),
  })
  .refine((e) => e.status !== "scheduled" || e.scheduled_at !== undefined, { message: "a scheduled entry needs scheduled_at", path: ["scheduled_at"] });

export type ImportEntry = z.infer<typeof ImportEntrySchema>;
export type ContentTypeDef = z.infer<typeof ContentTypeDefSchema>;

const documentFields = {
  format: z.literal(IMPORT_FORMAT_NAME),
  version: z.literal(IMPORT_FORMAT_VERSION),
  source: z
    .strictObject({
      name: z.string().max(200).optional(),
      url: z.string().max(LIMITS.url).optional(),
      exported_at: z.string().max(40).optional().describe("Written by a Writavo export: when."),
      export: z
        .strictObject({
          part: z.number().int().min(1),
          next: z.string().max(2000).nullable().describe("The cursor of the next volume (GET /export?cursor=...), or null for the last."),
        })
        .optional()
        .describe("Written by a Writavo export that came in volumes: which one this is."),
    })
    .optional()
    .describe("Informational only."),
  authors: z.array(AuthorSchema).optional(),
  categories: z.array(CategorySchema).optional(),
  tags: z.array(TagSchema).optional(),
  engagement: EngagementSchema.optional(),
  redirects: z
    .array(RedirectEntrySchema)
    .max(50_000)
    .optional()
    .describe("Old URLs that are not an article's own (category archives, pages, feeds) and where each goes now. An article's own old URLs go in its old_urls."),
  conversion: ConversionSchema.optional(),
  content_types: z
    .array(ContentTypeDefSchema)
    .max(100)
    .optional()
    .describe("Content types to create or change on the Site (applied first, like POST /content-types/apply; types the Site has and this list does not name are left alone)."),
  entries: z
    .array(ImportEntrySchema)
    .max(50_000)
    .optional()
    .describe("Entries of content types, created or updated after every article; references and media resolved once they all exist."),
};

export const ImportDocumentSchema = z
  .strictObject({
    ...documentFields,
    articles: z
      .array(ImportArticleSchema)
      .describe("Processed in file order. May be empty when the document carries entries or content types."),
  })
  .describe("Writavo Import Format v1: a blog's articles, authors, categories and tags, for import_content.");

/**
 * The same document with the articles left unparsed, so one bad article is reported against its
 * own external_id instead of failing the whole file.
 */
export const ImportEnvelopeSchema = z.strictObject({
  ...documentFields,
  // Rows are checked one by one (validate.ts), so one bad row is reported and skipped rather than
  // failing the document or the articles.
  engagement: EngagementEnvelopeSchema.optional(),
  redirects: z.array(z.unknown()).max(50_000).optional(),
  content_types: z.array(z.unknown()).max(100).optional(),
  entries: z.array(z.unknown()).max(50_000).optional(),
  articles: z.array(z.unknown()),
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
  authors: [
    {
      ref: "jane",
      name: "Jane Doe",
      slug: "jane-doe",
      bio: "Writes about gardening.",
      job_title: "Head gardener",
      socials: { linkedin: "https://www.linkedin.com/in/janedoe" },
      author_type: "co-founder",
      is_ai_generated: false,
    },
  ],
  categories: [{ slug: "guides", name: "Guides", description: "Step-by-step gardening guides." }],
  tags: [{ slug: "soil", name: "Soil", group_label: "Topics" }],
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
      old_urls: ["https://example.com/2021/03/how-to-test-your-soil/", "https://example.com/?p=1001"],
    },
    {
      external_id: "blog:1002",
      status: "draft",
      title: "Composting in winter",
      content: "Unfinished notes.",
      author: "jane",
    },
  ],
  redirects: [{ from: "https://example.com/category/guides/", to: "/category/guides" }],
};

/** The field guide, shared by the import-format resource, import_content and the migrate prompt. */
export const IMPORT_FORMAT_GUIDE = `# Writavo Import Format v1

A single JSON file describing a blog's articles, authors, categories and tags. import_content reads
it, checks it against the Site in a dry run, and then imports it in batches. Re-running an import
is safe: articles are matched by external_id, so a second run updates rather than duplicates.

Top level:
- format: always "writavo-import". version: always 1.
- source: optional, informational ({ name, url }).
- authors: [{ ref, name, slug?, bio?, avatar_url?, job_title?, socials?, author_type?,
  is_ai_generated? }]. ref is your own handle, used by articles[].author. Authors are matched on
  the Site by slug when given, else by exact name, and created when missing. An author already on
  the Site keeps everything it has: the import only fills fields that are empty there, and never
  changes its slug or name. socials is { network: https URL } with network one of
  ${AUTHOR_SOCIAL_NETWORKS.join(", ")}. author_type is ${AUTHOR_TYPES.join(", ")} (default user).
  is_ai_generated defaults to false, which is right for a real person.
- categories: [{ slug, name, description?, is_active?, parent? }] and tags: [{ slug, name, description?,
  group_label?, is_active? }]. Matched on the Site by slug, created when missing. Slugs are ${SLUG_RULE}, at
  most ${LIMITS.termSlug} characters. On a term already on the Site, description and group_label
  are filled only when it has none; nothing else about it changes. is_active: false creates the
  term ARCHIVED (kept and still on its articles, but hidden on the public blog and never chosen by
  the AI), for a term that was switched off at the source.
- articles: processed in file order. Each one:
  - kind: optional. "page" for a page such as About or Contact (served at the blog's root with no
    byline or date, never listed with the posts); "article" (the default) for a post.
  - external_id (required): your stable id from the source system, for example "blog:1234".
    1 to 255 printable ASCII characters. Never reuse one for a different article.
  - status (required): "published", "draft" or "scheduled". A published article is published on
    the Site with its ORIGINAL dates. A draft stays a draft. A scheduled article (a post scheduled
    at the source) needs scheduled_at, ISO 8601 with a timezone, and goes live then; one whose time
    has passed by the import is imported as a draft. Leave out anything unfinished or scraped.
  - title (max ${LIMITS.title}), slug (max ${LIMITS.slug}), content (markdown). All three are
    required when status is "published" or "scheduled". Keep the slug exactly as it is at the
    source, so the URL does not change. An embedded YouTube or Vimeo video, or a post on X, is a
    line of its own in content: ::embed{url="https://www.youtube.com/watch?v=..."}. Raw HTML
    (an <iframe>) never renders on the blog.
  - excerpt (max ${LIMITS.excerpt}), seo_title (max ${LIMITS.seoTitle}), seo_description
    (max ${LIMITS.seoDescription}), seo_keywords (array of strings).
  - Optional SEO overrides, what Yoast or Rank Math kept for the post: canonical_url (only when it
    pointed somewhere other than the post itself), noindex (true when the post was hidden from
    search engines), og_title (max ${LIMITS.seoTitle}), og_description (max
    ${LIMITS.seoDescription}), og_image: { url, alt? }. Leave out any the old system derived.
  - featured_image: { url, alt? }.
  - faqs: [{ question, answer }], key_takeaways: [string].
  - howto_steps: either [{ name, text?, image_url? }] or { name?, description?, steps: [{ name,
    text?, image_url? }] } when the how-to has its own title and summary.
  - comparison: { title?, headers: [string], rows: [[string]] }. Every row should have one cell
    per header.
  - author: an authors[].ref. category: the primary category's slug; categories: the slugs of any
    other categories it is filed under. tags: tag slugs. A nested category names its parent's slug
    in categories[].parent.
  - format: an article format key on the Site (the list_formats action). Optional.
  - source: optional, private (never on the public blog). The page the article was written from:
    { url, title?, competitor?, content?, originality_pct?, target_keywords?, metrics? }. With
    content (the source page's text, max 80,000 characters) Writavo measures how original the
    article is and labels it inspiration (85%+ original) or rewrite; without it, originality_pct
    is kept as the old system's reported figure. metrics: seo_score, organic_traffic, backlinks,
    referring_domains, ranking_keywords, top10_keywords.
  - cost_history: optional. What producing the article cost in the old system, for the record:
    [{ cost_usd, stage?, provider?, calls?, tokens?, occurred_on? (YYYY-MM-DD), description? }], at most
    500. Shown beside Writavo's own costs for the article, never billed and never counted against
    a spend cap. Sending it again replaces what was imported before.
  - published_at: required when published. When the article was FIRST published at the source,
    ISO 8601 with a timezone, in the past, not before 1990.
  - content_updated_at: optional. When its content last changed. Not before published_at.
  - old_urls: optional, at most 20. Every URL the article was reachable at in the old system, in
    full: its permalink (https://example.com/2021/03/my-post/), its ?p=123 link, any older
    permalink. Each answers with a 301 to the article once it is published, so links and
    rankings that point at the old URL keep working. Leave out a URL that is the same as the new
    one.

Engagement (optional, top level): the old blog's views, reactions and shares, so a migrated blog
keeps its counts. { daily: [...], reactions: [...] }, every row keyed by external_id (an article
in this document or already on the Site) or slug:
- daily: [{ external_id | slug, day (YYYY-MM-DD, UTC; any finished day, not today), views?,
  reactions? (a number, or per type: ${ENGAGEMENT_REACTIONS.join(", ")}), shares? ({ ${SHARE_PLATFORMS.join(", ")} }) }].
  Each row SETS that post's totals for that day, replacing whatever the day held, so re-running
  never double-counts. Writavo keeps a day's reactions as a total; the per-type counts on a post
  come from reactions[].
- reactions: [{ external_id | slug, visitor_id, reaction, set_at }]: each visitor's current pick.
  visitor_id is the anonymous id the old blog gave the visitor; Writavo stores only a hash of it,
  and when the new site sends the same id, the visitor still sees their pick.
It is sent after every article is imported; a bad row is reported and skipped, never a reason to
refuse the articles.

Redirects (optional, top level): old URLs that belong to no article, such as category and tag
archives, pages and feeds: [{ from, to | to_external_id, status?, note? }]. from is the old URL
(best in full); to is a path under the new blog (/category/guides) or a full https URL, or
to_external_id names an article. status is 301 (default) or 302. They and every article's old_urls
are sent after the articles are imported. A URL on the blog's own domain is answered by Writavo;
one it never receives (the old blog lived at the site root and the new one is under /blog) is kept
and listed for the customer's own server (GET /redirects/export).

Content types (optional, top level): the Site's content models, exactly as GET /content-types
returns them and POST /content-types/apply takes them: [{ api_id, kind?, name, description?,
title_field?, fields: [...] }]. Applied first; types the Site has and this list does not name are
left alone, and a type that exists is changed to match. The dry run shows the Site's plan and any
field the Site refuses.

Entries (optional, top level): entries of the content types, [{ external_id, type, slug?, status?
(draft, the default | published | scheduled with scheduled_at), unpublish_at?, data }]. data holds
the values by field API id. A reference is written portably, because an id means nothing on another
Site: { "$ref": { "type": "<content type, article or page>", "external_id": "..." } } or
{ "$ref": { "type": "category" | "tag" | "author", "slug": "..." } }. A media value is
{ "$media": { "url": "https://...", "alt": "..." } }, copied into the media library. Entries are
written after every article (matched by external_id, new ones created as drafts), then their
references and media are resolved and their status set. A reference to something neither in the
document nor on the Site is left out with a warning; importing again later fills it in.

Articles may carry custom_fields: the values of the Site's custom article fields (the content type
"article"), written the same portable way, and set after every entry exists.

A Writavo export (GET /export) is this format, in volumes of at most about 8 MB: import them in
order, and run a volume again if its report lists references it could not resolve yet. articles may
be empty when a document carries entries, content types, redirects or engagement.

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

/**
 * The sections import_content can return on its own (its `section` argument). The default,
 * "guide", is the guide and a sample: about 12 KB, where the whole document with the JSON Schema
 * is over 100 KB and overflows some MCP clients' response limits. A section is the guide's
 * paragraph for it (when there is one) plus that part of the JSON Schema.
 */
export const IMPORT_FORMAT_SECTIONS = [
  "guide",
  "sample",
  "schema",
  "authors",
  "categories",
  "tags",
  "articles",
  "cost_history",
  "engagement",
  "redirects",
  "content_types",
  "entries",
] as const;
export type ImportFormatSection = (typeof IMPORT_FORMAT_SECTIONS)[number];

/** The blank-line-separated paragraph of the guide that starts with `heading`, and what follows it that is indented. */
function guideParagraph(heading: string): string | null {
  const blocks = IMPORT_FORMAT_GUIDE.split(/\n\s*\n/);
  const at = blocks.findIndex((b) => b.trimStart().startsWith(heading));
  return at === -1 ? null : blocks[at]!.trimEnd();
}

const GUIDE_PARAGRAPH: Partial<Record<ImportFormatSection, string>> = {
  engagement: "Engagement (optional, top level)",
  redirects: "Redirects (optional, top level)",
  content_types: "Content types (optional, top level)",
  entries: "Entries (optional, top level)",
};

function jsonBlock(value: unknown): string[] {
  return ["```json", JSON.stringify(value, null, 2), "```"];
}

/** What `import_content` returns with no document: short by default, one part on request. */
export function importFormatSection(section: ImportFormatSection = "guide"): string {
  const schema = importFormatJsonSchema() as { properties?: Record<string, unknown> };
  const others = IMPORT_FORMAT_SECTIONS.filter((s) => s !== section);
  const more = `\nOther sections (call import_content with section: "<name>", no document): ${others.join(", ")}. The whole JSON Schema is section "schema", or at ${IMPORT_FORMAT_SCHEMA_ID}.`;
  switch (section) {
    case "guide":
      return [IMPORT_FORMAT_GUIDE, "## Sample document", "", ...jsonBlock(IMPORT_SAMPLE), more].join("\n");
    case "sample":
      return ["## Sample document", "", ...jsonBlock(IMPORT_SAMPLE), more].join("\n");
    case "schema":
      return ["## JSON Schema", "", ...jsonBlock(importFormatJsonSchema())].join("\n");
    case "cost_history": {
      const articles = schema.properties?.["articles"] as { items?: { anyOf?: { properties?: Record<string, unknown> }[] } } | undefined;
      const fragment = articles?.items?.anyOf?.map((a) => a.properties?.["cost_history"]).find((x) => x !== undefined);
      const bullet = IMPORT_FORMAT_GUIDE.split(/\n(?=  - )/).find((b) => b.trimStart().startsWith("- cost_history"));
      return [
        "## cost_history (on each article)",
        "",
        bullet?.trimEnd() ?? "",
        "",
        "It is sent while the article is written and, for an article that is already live when publish is false, on its own after the articles (cost history never appears on the public blog, so it is written either way).",
        "",
        ...(fragment ? ["JSON Schema of the field:", ...jsonBlock(fragment)] : []),
        more,
      ].join("\n");
    }
    default: {
      const paragraph = GUIDE_PARAGRAPH[section] ? guideParagraph(GUIDE_PARAGRAPH[section]!) : null;
      const fragment = schema.properties?.[section];
      return [
        `## ${section}`,
        "",
        ...(paragraph ? [paragraph, ""] : []),
        ...(fragment ? ["JSON Schema of the section:", ...jsonBlock(fragment)] : ["No JSON Schema for this section."]),
        more,
      ].join("\n");
    }
  }
}
