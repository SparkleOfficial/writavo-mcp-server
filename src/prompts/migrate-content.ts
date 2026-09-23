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
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Move my existing blog into Writavo${source ? `. The content currently lives here: ${source}` : ""}.

The goal is a faithful move: every article keeps its slug (so its URL does not change), its
original publication date, its author, category and tags, and its images. Published posts stay
published, drafts stay drafts, and nothing is rewritten.

Work in this order, and tell me what you find at each step:

1. Sign in. Call login_status. If this assistant is not signed in to Writavo, call login and show
   me the link and code it returns. I may need to create an account and finish onboarding first;
   if onboarding asks, I should choose "Bring my existing articles". Call login_status every few
   seconds until it says approved.
2. Confirm the Site. Call get_site_info and tell me the Site's name and domain, and ask me to
   confirm it is the one the blog should move into. Call get_content_types and list_articles with
   a small limit so we both know what is already there.
3. Inspect the source, using only access I already have: the files, database, export or API in my
   workspace${source ? ` (${source})` : ""}. Read how posts, authors, categories, tags and images
   are stored before writing anything. Tell me how many posts there are, how many are published
   and how many are drafts, and ask about anything ambiguous rather than guessing.
4. Map it to the Writavo Import Format. Call import_content with no arguments (or read the
   writavo://import-format resource) for the exact format, then map field by field:
   - external_id: the source's own stable id for the post, prefixed so it is unique, for example
     "blog:<id>". It must never change between runs; it is how a second run updates rather than
     duplicates.
   - status: "published" only for posts that are live at the source. Real drafts stay "draft".
     Leave out anything unfinished, duplicated, scraped, auto-generated filler or test posts, and
     tell me what you left out and why.
   - slug: exactly the source slug, character for character, so the URL does not change.
   - published_at: the ORIGINAL first publication date from the source, with its timezone. Not
     the date of the export, not today, not the last modified date. content_updated_at is the
     last content change, if the source records it.
   - content: markdown. If the source stores HTML, convert it to markdown carefully and keep the
     text itself exactly as written. Write images as ![alt](https://...) so they are copied.
   - images: if the source keeps a map from old image URLs to new ones (a CDN migration, for
     example), apply it before exporting, so the importer copies the images that actually exist.
   - authors (with a ref each), categories and tags (with slugs), and each post's author,
     category and tags pointing at them. Mark real people with is_ai_generated false.
   - excerpt, seo_title, seo_description and featured_image wherever the source has them.
5. Write the JSON file somewhere in the workspace and call import_content with its absolute
   file_path. That is a dry run: it checks everything against the Site and writes nothing.
6. Show me the dry run report: how many will be created, updated and published, the problems and
   warnings, the images and the estimate. Fix the problems in the file (never by inventing data)
   and run the dry run again until it is clean or the remaining problems are ones I accept.
7. Apply. The import publishes posts on my live site with their original dates, so ask me first.
   Only after I agree, call import_content with dry_run false and confirm true. It imports one
   batch per call: call it again with the same arguments until it says the import is complete,
   and show me the progress as it goes.
8. Verify. Call list_articles (status published, order published_at.desc, with fields
   id,title,slug,published_at) and compare against the source: the counts, the slugs and the dates.
   Spot check two or three articles with get_article, including their images. Report anything
   that does not match.
9. Next steps. Tell me what is left to do so the blog is actually served from Writavo: set up
   delivery for my domain in the dashboard, and, if my site builds from this content, set up a
   webhook in the dashboard so it revalidates when articles change. Do not buy or change a plan
   for this: storing, importing and publishing content needs no plan.

Never delete or unpublish anything, on the source or on Writavo.`,
        },
      },
    ],
  };
}
