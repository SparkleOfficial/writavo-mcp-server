export interface MigrateContentArgs {
  source?: string;
}

/** Which server is asking: the stdio one signs in with login and can read files; the hosted one cannot. */
export type PromptHost = "stdio" | "remote";

/**
 * Move an existing blog into Writavo, faithfully. The prompt is the workflow; import_content is
 * the machinery. What a model is trusted with here is reading the source system and mapping it,
 * which is the part that differs for every customer. Everything that has to be exactly right on
 * the Writavo side (matching, idempotency, dates, images, pacing) is done by the tool.
 */
export function migrateContentPrompt(args: MigrateContentArgs, host: PromptHost = "stdio") {
  const source = args.source?.trim();
  const signIn =
    host === "stdio"
      ? `1. Connect. Call login_status. If this assistant is not signed in to Writavo, call login and show
   me the link and code it returns; call login_status every few seconds until it says approved. I
   may need to create an account and finish onboarding first; if onboarding asks, I should choose
   "Bring my existing articles" (the AI pipeline then stays off).`
      : `1. Connect. Call get_site_info. If it says this assistant is not signed in, ask me to reconnect
   the Writavo connector in this assistant (it signs in through the browser; I may need to create
   an account and finish onboarding first, choosing "Bring my existing articles"). This hosted
   server cannot read files on my machine: if the export ends up as files here, or the images are
   local files, tell me to add the local server (npx -y @writavo/mcp-server) and use that instead.`;
  const dryRun =
    host === "stdio"
      ? `7. Dry run. Write the JSON document to the export folder and call import_content with its
   absolute path (any size; progress is saved next to the file). That is a dry run: it checks
   everything against the Site and writes nothing.`
      : `7. Dry run. Call import_content with the document inline as data, at most 50 articles and 2 MB
   per call. Split a bigger blog into several documents, each carrying the authors, categories and
   tags its own articles use, and dry-run each one. A dry run checks everything and writes nothing.`;
  const apply =
    host === "stdio"
      ? `   Only after I agree, call import_content with the same path, dry_run false and confirm true. It
   imports one batch per call: call it again with the same arguments until it says the import is
   complete, and show me the progress as it goes. Use retry_failed true once for anything skipped.`
      : `   Only after I agree, call import_content with dry_run false and confirm true, one document at a
   time. If a call stops before the end it lists the articles still to do: send only those next.
   Show me the progress as it goes.`;
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
   review -> "draft"; scheduled -> "draft", scheduled again after the import with schedule_article;
   private, password protected or members only -> ask me; trashed, revisions, test posts -> leave
   out. Tell me everything you leave out and why.
5. Export, read only, into the export folder.
6. Map to the Writavo Import Format. Call import_content with no arguments (or read the
   writavo://import-format resource) for the exact format, then map field by field:
   - external_id: the source's own stable id, prefixed with the system, for example "wp:1042". It
     must never change between runs; it is how a second run updates rather than duplicates.
   - slug: exactly the source slug, character for character. If one breaks the slug rule (capitals,
     underscores, accents), ask me: changing it changes the URL.
   - published_at: the ORIGINAL first publication date, with its timezone. Not the export date, not
     today, not the last modified date. content_updated_at is the last content change.
   - content: markdown, words unchanged. Images as ![alt](https://...) so they are copied; relative
     image paths need their absolute https URL${host === "stdio" ? " or an upload_media call with the local path" : ""}.
   - authors (a ref each; is_ai_generated false for real people), categories and tags (slug and
     name), and each post's author, ONE category and its tags.
   - excerpt, seo_title, seo_description, seo_keywords, featured_image, faqs, key_takeaways,
     howto_steps and comparison wherever the source has them.
   Some things have no place in the format: a second category, category parents and descriptions,
   author emails and links, a comparison's title, a how-to's title, description, time or supplies,
   canonical URLs, custom fields, comments, embeds and shortcodes, and non-https or non-image
   files. Do not squeeze them into another field: list them for me per article.
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
