import { MIGRATION_SCOPES } from "../import/engine.js";

export interface MigrateContentArgs {
  source?: string;
}

/**
 * Move an existing blog into Writavo, faithfully. The prompt is the workflow; import_content is
 * the machinery. What a model is trusted with here is reading the source system and mapping it,
 * which is the part that differs for every customer. Everything that has to be exactly right on
 * the Writavo side (matching, idempotency, dates, images, pacing) is done by the tool.
 */
export function migrateContentPrompt(args: MigrateContentArgs) {
  const source = args.source?.trim();
  const signIn = `1. Connect. Call get_site_info. If it says this assistant is not signed in, ask me to reconnect
   the Writavo connector in this assistant (it signs in through the browser; I may need to create
   an account and finish onboarding first, choosing "Bring my existing articles"). This server
   does not read files from my machine, but it keeps the import document and its progress on the
   server as an import, so you send it once and continue by its import_id. Images are copied from
   https URLs only.
   Then call verify_api_key and check the connection carries every permission a full move needs,
   before any work starts: ${MIGRATION_SCOPES.join(", ")}. If any is missing, tell me which, and
   ask me to add them in one step: Settings > AI agents, this connection, Permissions, "Migrate a
   blog" (or reconnect and choose "Migrate a blog" on the sign-in screen).`;
  const dryRun = `7. Dry run. Write the JSON document to the export folder and get it to the server, best first:
   if you can run shell commands, call import_content with upload: true and run the curl command
   it returns (up to 10 MB; the file never passes through our conversation); if it is at an https
   URL, pass url; otherwise send it as data in parts of at most 50 articles and 512 KB, passing the
   import_id the first part returned with every further part. Then call import_content with just
   that import_id. A dry run checks everything, reports every problem in one pass, and writes
   nothing. To fix entries, send them again as data with the import_id: same ref, slug or
   external_id replaces the stored one.`;
  const apply = `   Only after I agree, call import_content with the import_id, dry_run false and confirm true
   (or publish false to import everything as drafts). It runs in the background on Writavo's
   server until every article is done and returns at once; check it every minute or two with the
   import_id and status: true, show me the progress, and do not start it again while it runs. If
   it stops with a problem, fix the cause and start it again: it carries on where it stopped.`;
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Move my existing blog into Writavo${source ? `. The content currently lives here: ${source}` : ""}.

The goal is a faithful move: every article keeps its slug (so its URL does not change), its
original publication date, its author, category and tags, and its images. Published posts stay
published, drafts stay drafts, and nothing is rewritten. The full runbook, with export recipes for
WordPress, Ghost, Sanity, Contentful, Webflow, markdown files and databases, is
https://writavo.com/docs/migrate.md: read it if anything below is unclear.

Rules for the whole job:
- The source stays read only: exports, GET requests and SELECT queries only. Never edit, delete or
  unpublish anything there, and never delete or unpublish anything on Writavo either.
- Copy text verbatim. Converting HTML to markdown changes the format, never the words.
- Never guess a slug, a date or missing text. If something is missing or ambiguous, ask me.
- Write export files to a folder outside any git repository (for example ~/writavo-migration/) and
  never commit them. My credentials for the old system stay on my machine and never go to Writavo.
- Do not connect any delivery or change my live site. Switching over is my decision, at the end.

Work in this order, and tell me what you find at each step:

${signIn}
2. Confirm the Site. Call get_site_info and tell me the Site's name and domain, and ask me to
   confirm it is the one the blog should move into. Call get_content_types and list_articles with
   a small limit so we both know what is already there.
3. Inventory the source, using only access I already have${source ? ` (${source})` : ""}. Read how
   posts, authors, categories, tags and images are stored before exporting anything. Report: posts
   by status (published, draft, scheduled, private or members only, trashed), authors, categories,
   tags, posts with more than one category, where the images are hosted, embeds or shortcodes, the
   oldest and newest publish dates, and the URL pattern of a post.
4. Agree the statuses with me. Default: published and public -> "published"; drafts and pending
   review -> "draft"; scheduled -> "scheduled" with its scheduled_at (it goes live then; one whose
   time has passed comes in as a draft); private, password protected or members only -> ask me;
   trashed, revisions, test posts -> leave out. Tell me everything you leave out and why.
5. Export, read only, into the export folder. FROM WORDPRESS, skip steps 5 and 6: Writavo converts it
   itself. Ask me for the export file (Tools > Export > All content, an .xml file) and send it as
   it is with import_content upload: true, or call import_content with wordpress_url (published
   posts only unless I give a user name and an Application Password). Then go to the dry run.
6. Map to the Writavo Import Format. Call import_content with no arguments (or read the
   writavo://import-format resource) for the exact format, then map field by field:
   - external_id: the source's own stable id, prefixed with the system, for example "wp:1042". It
     must never change between runs; it is how a second run updates rather than duplicates.
   - slug: exactly the source slug, character for character. If one breaks the slug rule (capitals,
     underscores, accents), ask me: changing it changes the URL.
   - published_at: the ORIGINAL first publication date, with its timezone. Not the export date, not
     today, not the last modified date. content_updated_at is the last content change.
   - content: markdown, words unchanged. Images as ![alt](https://...) so they are copied; relative
     image paths need their absolute https URL (a local image file can be uploaded with upload_media as base64 and its returned URL used).
     A YouTube or Vimeo video or a post on X becomes a line of its own: ::embed{url="https://..."}.
   - authors (a ref each; is_ai_generated false for real people), categories and tags (slug,
     name and description; a tag also its group_label; a nested category its parent's slug), and
     each post's author, its primary category (category), any other categories (categories) and
     its tags.
   - excerpt, seo_title, seo_description, seo_keywords, featured_image, faqs, key_takeaways,
     howto_steps (with its own name and description when it has them) and comparison (with its
     title) wherever the source has them.
   - The SEO plugin's per-post overrides (Yoast, Rank Math): canonical_url only when it pointed
     somewhere other than the post itself, noindex when the post was hidden from search, and
     og_title, og_description and og_image when the social share differed.
   - source, when the old system recorded the page an article was written from: its url, title,
     competitor, the page's text (content, so Writavo can measure originality) and metrics. It
     stays private. Categories and tags switched off at the source: is_active false.
   Some things have no place in the format: author emails,
   a how-to's time or supplies, custom fields, comments, embeds other than YouTube, Vimeo and X,
   shortcodes, and non-https or non-image files. Do not squeeze them into another field: list them for me per article.
${dryRun}
8. Show me the dry run report: how many will be created, updated and published, the problems and
   warnings, the images. Fix problems in the document (never by inventing data) and run the dry
   run again until it is clean or the remaining problems are ones I accept.
9. Import. The import publishes posts with their original dates, so ask me first.
${apply}
10. Verify parity against the inventory and report every difference: published and draft counts,
   the set of slugs (none missing, none extra), every published_at to the second in UTC, authors,
   categories and tags, and that no content or featured image still points at the old image host.
   Read two or three articles in full with get_article. Use list_articles with status published,
   fields id,title,slug,published_at and paging.
11. Next steps. Tell me the options for serving the blog from Writavo (the Delivery page in the
   dashboard: a subdirectory on my domain, a subdomain, or my own site reading the headless API
   with a publishable key plus a webhook for revalidation), and the SEO cautions: keep every URL
   the same, add 301 redirects before switching if any must change, and switch in one step so no
   article is live at two addresses. If the old blog keeps changing, a re-run of the export and
   import updates what changed. Do not buy or change a plan: moving a blog needs none.`,
        },
      },
    ],
  };
}
