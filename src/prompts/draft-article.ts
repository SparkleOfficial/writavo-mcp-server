export interface DraftArticleArgs {
  topic: string;
  angle?: string;
}

/**
 * Research a topic and leave a draft behind. Deliberately stops short of publishing: the whole
 * safety property of this API is that nothing becomes public without a separate, explicit call,
 * and a prompt that ended in a publish would quietly hand that decision to a model.
 */
export function draftArticlePrompt(args: DraftArticleArgs) {
  return {
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: `Write a draft article about: ${args.topic}
${args.angle ? `\nThe angle to take: ${args.angle}\n` : ""}
Work in this order:

1. Call get_site_info to learn the Site's name, locale and timezone.
2. Call list_articles with a small limit to read what is already published. Match its voice,
   its heading style and its typical length. If an existing article already covers this topic,
   say so and stop rather than writing a near duplicate.
3. Call list_categories and list_authors, and pick the category and author that fit. If nothing
   fits, ask me rather than guessing.
4. Research the topic properly and write the article in markdown. Real substance, specific
   examples, no filler. Use hyphens rather than em-dashes or en-dashes.
5. Call create_article with title, slug, content, excerpt, seo_title, seo_description,
   category_id and author_id.

Leave it as a draft. Do not publish it, do not schedule it, and do not call
trigger_pipeline_run. When you are done, tell me the article id and what still needs a human
eye before it goes live.`,
        },
      },
    ],
  };
}
