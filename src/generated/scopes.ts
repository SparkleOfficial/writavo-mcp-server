// GENERATED FILE. Do not edit.
//   source: openapi.yaml
//   regenerate: pnpm mcp:gen
//
// `pnpm docs:check` rule 12 re-runs the generator and diffs it against what is committed, so
// a hand edit here fails CI rather than quietly becoming a second copy of the contract.

/**
 * Where a person grants each scope on the sign-in screen (one row per area, set to No access,
 * Read or Read and write). For messages that tell someone what to change; not an authorisation.
 */
export const SCOPE_SCREEN: Record<string, string> = {
  "articles:read": "Articles, Read",
  "articles:write": "Articles, Read and write",
  "engagement:write": "Articles, Read and write (importing views, reactions and shares also needs your own articles.write permission)",
  "entries:read": "Content types and entries, Read",
  "entries:write": "Content types and entries, Read and write",
  "content_types:write": "Content types and entries, Read and write (only if you may change content types)",
  "taxonomy:read": "Categories, tags and authors, Read",
  "taxonomy:write": "Categories, tags and authors, Read and write",
  "authors:read": "Categories, tags and authors, Read",
  "authors:write": "Categories, tags and authors, Read and write",
  "media:read": "Media, Read",
  "media:write": "Media, Read and write",
  "pipeline:read": "AI pipeline, Read",
  "pipeline:run": "AI pipeline, Read, plan and run (spends credits)",
  "plan:write": "AI pipeline, Read, plan and run (spends credits)",
  "pipeline:config": "AI pipeline, Read, plan and run (only if you may configure the pipeline)",
  "prompts:write": "AI pipeline, Read, plan and run (only if you may edit prompts)",
  "site:read": "Site settings and design, Read",
  "site:write": "Site settings and design, Read and write",
  "delivery:read": "Publishing and domains, Read",
  "delivery:write": "Publishing and domains, Read and write (domains can cost money)",
  "integrations:write": "Publishing and domains, Read and write (only if you may manage integrations)",
  "seo:read": "SEO, Read",
  "seo:write": "SEO, Read and write (scans spend credits)",
  "outreach:read": "Outreach contacts, Read (off unless you choose it)",
  "team:read": "Team and organisation, Read",
  "team:write": "Team and organisation, Read and write",
  "roles:write": "Team and organisation, Read and write (only if you may edit roles)",
  "org:write": "Team and organisation, Read and write (only if you may edit the organisation)",
  "billing:read": "Billing, Read",
  "billing:write": "Billing, Read and write (spends money)",
  "insights:read": "Reports and logs, Read",
  "logs:read": "Reports and logs, Read",
  "meta:read": "always included: the Site name and settings",
  "keys:read": "not available to an AI agent: a person creates API keys in Settings > API keys",
  "keys:write": "not available to an AI agent: a person creates API keys in Settings > API keys",
  "webhooks:read": "not available to an AI agent: a person sets up webhooks in Settings > Webhooks",
  "webhooks:write": "not available to an AI agent: a person sets up webhooks in Settings > Webhooks"
};
