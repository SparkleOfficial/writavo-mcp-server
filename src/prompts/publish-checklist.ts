export interface PublishChecklistArgs {
  article_id: string;
}

/**
 * Walk one draft through everything that is embarrassing to get wrong in public, then ask before
 * making it public. The publish step is left to the user's explicit yes, which is also what
 * publish_article itself enforces.
 */
export function publishChecklistPrompt(args: PublishChecklistArgs) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Get article ${args.article_id} ready to publish, then stop and ask me.

Work through this checklist:

1. Call get_article for ${args.article_id} and read the whole thing.
2. Title and slug. The title should read like something a person would click. The slug should be
   short, lowercase and hyphenated, and it should still make sense in a year. Changing a slug
   after publishing breaks the live URL and nothing is redirected, so get it right now.
3. SEO. seo_title and seo_description must be present and must not simply repeat the title.
4. Excerpt. One or two sentences that stand alone in a list of posts.
5. Category and author. Exactly one category, and a real byline. Call list_categories and
   list_authors if either is missing.
6. Featured image. If featured_image_url is empty, ask me for one, or call upload_media if I
   give you a file, and set it with update_article. Include alt text.
7. Body. Check the markdown renders, headings are in order, links resolve, and there are no
   em-dashes or en-dashes.

Apply the fixes with update_article. Then show me a short summary of what you changed and what
the article will look like live, and ask whether to publish. Only call publish_article, with
confirm: true, after I say yes. If I would rather it went out later, use schedule_article
instead and confirm the time with me first.`,
        },
      },
    ],
  };
}
