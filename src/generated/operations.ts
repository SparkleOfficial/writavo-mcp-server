// GENERATED FILE. Do not edit.
//   source: openapi.yaml
//   regenerate: pnpm mcp:gen
//
// `pnpm docs:check` rule 12 re-runs the generator and diffs it against what is committed, so
// a hand edit here fails CI rather than quietly becoming a second copy of the contract.

/** Where a tool argument goes on the wire. */
export type ParamLocation = "path" | "query" | "body";

/** A tool argument, reduced to what building a schema and a request needs. */
export interface McpParam {
  name: string;
  in: ParamLocation;
  kind: "string" | "number" | "integer" | "boolean" | "array" | "object";
  itemKind?: "string" | "number" | "integer" | "boolean" | "object";
  itemEnum?: string[];
  enum?: string[];
  format?: string;
  required: boolean;
  nullable: boolean;
  explode: boolean;
  description: string;
}

/** Why a tool asks before it acts. Null means it does not need to. */
export type ConfirmReason = "spend" | "destructive" | "public" | null;

export interface McpOperation {
  /** The MCP tool name. */
  tool: string;
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** The path template, relative to the base URL. `{id}` segments are filled from params. */
  path: string;
  tag: string;
  summary: string;
  /** What the model reads when it chooses between tools. */
  description: string;
  scope: string;
  entitlement: string;
  publishable: boolean;
  spendsCredits: boolean;
  makesPublic: boolean;
  readOnly: boolean;
  confirm: boolean;
  confirmReason: ConfirmReason;
  /** The API requires an Idempotency-Key. The client generates one per call. */
  idempotency: boolean;
  /** The API accepts If-Match, so the tool takes an optional if_match argument. */
  ifMatch: boolean;
  params: McpParam[];
}

/** An operation deliberately not exposed to an assistant, and the reason shown when asked. */
export interface McpRefusal {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  reason: string;
}

export const API_BASE_URL = "https://api.writavo.com/v1";
export const API_VERSION = "1.1.0";

export const OPERATIONS: McpOperation[] = [
  {
    "tool": "verify_api_key",
    "operationId": "ping",
    "method": "GET",
    "path": "/ping",
    "tag": "Meta",
    "summary": "Verify a key",
    "description": "Verify a key. The cheapest possible authenticated call. Returns the kind of key you presented and the scopes it carries. Use it to confirm credentials during setup, and as a liveness probe. It touches no content, so it is exempt from the write rate limit. Read only. Nothing is changed.",
    "scope": "none",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": []
  },
  {
    "tool": "get_site_info",
    "operationId": "getSite",
    "method": "GET",
    "path": "/site",
    "tag": "Meta",
    "summary": "Read Site information",
    "description": "Read Site information. Public facing information about the Site your key belongs to: its display name, the domain its blog is served from, its locale and its timezone. Scheduling times are interpreted against this timezone when no offset is supplied. Read only. Nothing is changed. Needs a key carrying the meta:read scope.",
    "scope": "meta:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": []
  },
  {
    "tool": "get_content_types",
    "operationId": "listContentTypes",
    "method": "GET",
    "path": "/content-types",
    "tag": "Meta",
    "summary": "List content types",
    "description": "List content types. The article formats available to this Site. A format is an SEO blueprint (How-To, Listicle, Versus and so on) that shapes how the generator structures an article, and that you may set on any article via `format_id`. Read only. Nothing is changed. Needs a key carrying the meta:read scope.",
    "scope": "meta:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": []
  },
  {
    "tool": "get_usage",
    "operationId": "getUsage",
    "method": "GET",
    "path": "/usage",
    "tag": "Meta",
    "summary": "Read plan limits, usage and balances",
    "description": "Read plan limits, usage and balances. What your plan allows, what you have used in the current period, and what you can still spend. Read this before a pipeline run if you want to fail fast rather than handle a 402, and read it after a run to see the balance move. Read only. Nothing is changed. Needs a secret key (wv_sk_) carrying the meta:read scope.",
    "scope": "meta:read",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": []
  },
  {
    "tool": "list_articles",
    "operationId": "listArticles",
    "method": "GET",
    "path": "/articles",
    "tag": "Articles",
    "summary": "List articles",
    "description": "List articles. Cursor paginated, newest updated first. Read only. Nothing is changed. Needs a key carrying the articles:read scope.",
    "scope": "articles:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "fields",
        "in": "query",
        "required": false,
        "description": "Comma separated field allow list. Any field of the Article schema may be named. Omit for the default projection, which is: `id, status, title, slug, excerpt, featured_image_url, category_id, author_id, format_id, published_at, scheduled_publish_at, created_at, updated_at`.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "status",
        "in": "query",
        "required": false,
        "description": "Filter by status. Repeat the parameter to match several. A publishable key may only ask for `published`, and any other value is rejected with `403 INSUFFICIENT_SCOPE`.",
        "explode": true,
        "kind": "array",
        "nullable": false,
        "itemKind": "string",
        "itemEnum": [
          "discovered",
          "scored",
          "skipped",
          "scraped",
          "generated",
          "needs_improvement",
          "needs_images",
          "queued",
          "published",
          "rejected",
          "failed",
          "draft",
          "scheduled"
        ]
      },
      {
        "name": "category_id",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "author_id",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "tag_id",
        "in": "query",
        "required": false,
        "description": "Return only articles carrying this tag.",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "slug",
        "in": "query",
        "required": false,
        "description": "Exact slug match. Slugs are unique within a Site, so this returns at most one article.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "external_id",
        "in": "query",
        "required": false,
        "description": "Exact `external_id` match. Unique within a Site, so this returns at most one article. An importer calls this before writing, to update an article it brought in on an earlier run rather than create a second copy.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "updated_since",
        "in": "query",
        "required": false,
        "description": "Return only articles updated at or after this instant. This is the incremental sync parameter: store the greatest `updated_at` you have seen and pass it back next time.",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "date-time"
      },
      {
        "name": "order",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "enum": [
          "updated_at.desc",
          "updated_at.asc",
          "published_at.desc",
          "published_at.asc",
          "created_at.desc"
        ]
      }
    ]
  },
  {
    "tool": "create_article",
    "operationId": "createArticle",
    "method": "POST",
    "path": "/articles",
    "tag": "Articles",
    "summary": "Create an article",
    "description": "Create an article. Creates an article at `status: draft`. Always. There is no request field that can make it public, and supplying `status` is a validation error rather than a silent ignore, so a client written against a different CMS fails loudly instead of quietly leaving content unpublished. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": true,
    "ifMatch": false,
    "params": [
      {
        "name": "title",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "slug",
        "in": "body",
        "required": false,
        "description": "Derived from `title` when omitted. Supply it if the URL matters.",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "external_id",
        "in": "body",
        "required": false,
        "description": "Your id for this article in the system it came from. Unique within the Site.",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "content",
        "in": "body",
        "required": false,
        "description": "Markdown.",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "excerpt",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "featured_image_url",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uri"
      },
      {
        "name": "seo_title",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "seo_description",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "seo_keywords",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "string"
      },
      {
        "name": "faqs",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "object"
      },
      {
        "name": "key_takeaways",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "string"
      },
      {
        "name": "howto_steps",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "object"
      },
      {
        "name": "comparison",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "object",
        "nullable": true
      },
      {
        "name": "category_id",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uuid"
      },
      {
        "name": "author_id",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uuid"
      },
      {
        "name": "format_id",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uuid"
      },
      {
        "name": "tag_ids",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": false,
        "itemKind": "string"
      }
    ]
  },
  {
    "tool": "get_article",
    "operationId": "getArticle",
    "method": "GET",
    "path": "/articles/{id}",
    "tag": "Articles",
    "summary": "Read one article",
    "description": "Read one article. Returns the full article including `content`. A publishable key may only read an article at `status: published`; anything else returns 404, for the same no disclosure reason that governs cross Site access. Read only. Nothing is changed. Needs a key carrying the articles:read scope.",
    "scope": "articles:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "fields",
        "in": "query",
        "required": false,
        "description": "Comma separated field allow list. Omit to receive every readable field.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "update_article",
    "operationId": "updateArticle",
    "method": "PATCH",
    "path": "/articles/{id}",
    "tag": "Articles",
    "summary": "Update an article",
    "description": "Update an article. A partial update. Only the fields you send are touched. Send `null` to clear a nullable field; omit it to leave it alone. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": true,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "title",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "slug",
        "in": "body",
        "required": false,
        "description": "Changing the slug of a published article changes its live URL and nothing is redirected for you. The old URL starts returning 404.",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "external_id",
        "in": "body",
        "required": false,
        "description": "Your id for this article in the system it came from. `null` clears it.",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "content",
        "in": "body",
        "required": false,
        "description": "Markdown.",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "excerpt",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "featured_image_url",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uri"
      },
      {
        "name": "seo_title",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "seo_description",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "seo_keywords",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "string"
      },
      {
        "name": "faqs",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "object"
      },
      {
        "name": "key_takeaways",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "string"
      },
      {
        "name": "howto_steps",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "array",
        "nullable": true,
        "itemKind": "object"
      },
      {
        "name": "comparison",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "object",
        "nullable": true
      },
      {
        "name": "category_id",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uuid"
      },
      {
        "name": "author_id",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uuid"
      },
      {
        "name": "format_id",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uuid"
      },
      {
        "name": "tag_ids",
        "in": "body",
        "required": false,
        "description": "Full replacement, not a merge. Send `[]` to clear.",
        "explode": false,
        "kind": "array",
        "nullable": false,
        "itemKind": "string"
      }
    ]
  },
  {
    "tool": "delete_article",
    "operationId": "deleteArticle",
    "method": "DELETE",
    "path": "/articles/{id}",
    "tag": "Articles",
    "summary": "Delete an article",
    "description": "Delete an article. Permanent. The row and its tag assignments are removed, and if the article was published its URL starts returning 404 on your blog once the cache is purged. PERMANENT: this deletes content from the customer's Site. There is no trash and no undo. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "destructive",
    "idempotency": false,
    "ifMatch": true,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "publish_article",
    "operationId": "publishArticle",
    "method": "POST",
    "path": "/articles/{id}/publish",
    "tag": "Articles",
    "summary": "Publish an article",
    "description": "Publish an article. Makes the article public immediately, at `status: published`. PUBLIC: this makes the article publicly visible on the customer's own live site, where search engines and readers will see it. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": true,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "public",
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "published_at",
        "in": "body",
        "required": false,
        "description": "The date the article was ORIGINALLY published, for an article imported from another system. First publish only; must be in the past. Omit it to publish now.",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "date-time"
      },
      {
        "name": "content_updated_at",
        "in": "body",
        "required": false,
        "description": "When the imported article's content last changed at its source. First publish only; must be in the past and not earlier than `published_at`.",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "date-time"
      }
    ]
  },
  {
    "tool": "unpublish_article",
    "operationId": "unpublishArticle",
    "method": "POST",
    "path": "/articles/{id}/unpublish",
    "tag": "Articles",
    "summary": "Unpublish an article",
    "description": "Unpublish an article. Takes the article off the web and returns it to `status: draft`. The URL starts returning 404 on your blog once the cache is purged. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "schedule_article",
    "operationId": "scheduleArticle",
    "method": "POST",
    "path": "/articles/{id}/schedule",
    "tag": "Articles",
    "summary": "Schedule an article",
    "description": "Schedule an article. Moves the article to `status: scheduled` and records when it should go live. A cron publishes it within a few minutes of that time, whether or not the AI pipeline is switched on for your Site. PUBLIC: this makes the article publicly visible on the customer's own live site, where search engines and readers will see it. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": true,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "public",
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "scheduled_publish_at",
        "in": "body",
        "required": true,
        "description": "ISO 8601. Include an offset. If you omit one it is read in the Site's timezone, which you can get from `GET /site`.",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "date-time"
      }
    ]
  },
  {
    "tool": "cancel_article_schedule",
    "operationId": "cancelArticleSchedule",
    "method": "POST",
    "path": "/articles/{id}/cancel-schedule",
    "tag": "Articles",
    "summary": "Cancel a scheduled publish",
    "description": "Cancel a scheduled publish. Returns the article to `status: draft` and clears `scheduled_publish_at`. The content is untouched. Calling this on an article that is not scheduled is a no-op that returns the current state. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the articles:write scope.",
    "scope": "articles:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "list_categories",
    "operationId": "listCategories",
    "method": "GET",
    "path": "/categories",
    "tag": "Categories",
    "summary": "List categories",
    "description": "List categories. Every category on the Site, alphabetically. Categories are a closed taxonomy: an article has exactly one, or none. Read only. Nothing is changed. Needs a key carrying the taxonomy:read scope.",
    "scope": "taxonomy:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "fields",
        "in": "query",
        "required": false,
        "description": "Comma separated field allow list. Default projection: `id, name, slug, article_count`.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "create_category",
    "operationId": "createCategory",
    "method": "POST",
    "path": "/categories",
    "tag": "Categories",
    "summary": "Create a category",
    "description": "Create a category. `slug` is unique within the Site. A collision returns `409 SLUG_CONFLICT` rather than silently appending a suffix, so your URLs are never a surprise. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the taxonomy:write scope.",
    "scope": "taxonomy:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": true,
    "ifMatch": false,
    "params": [
      {
        "name": "name",
        "in": "body",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "slug",
        "in": "body",
        "required": false,
        "description": "Derived from `name` when omitted.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "get_category",
    "operationId": "getCategory",
    "method": "GET",
    "path": "/categories/{id}",
    "tag": "Categories",
    "summary": "Read one category",
    "description": "Read one category. Read only. Nothing is changed. Needs a key carrying the taxonomy:read scope.",
    "scope": "taxonomy:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "update_category",
    "operationId": "updateCategory",
    "method": "PATCH",
    "path": "/categories/{id}",
    "tag": "Categories",
    "summary": "Update a category",
    "description": "Update a category. Renaming is safe. Changing `slug` changes the category archive URL on your blog, and nothing is redirected for you, so change it only if you accept the broken link. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the taxonomy:write scope.",
    "scope": "taxonomy:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": true,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "name",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "slug",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "delete_category",
    "operationId": "deleteCategory",
    "method": "DELETE",
    "path": "/categories/{id}",
    "tag": "Categories",
    "summary": "Delete a category",
    "description": "Delete a category. Articles in this category are not deleted. Their `category_id` becomes `null`, so they stay published and simply lose their category. Removing a category never removes content. PERMANENT: this deletes content from the customer's Site. There is no trash and no undo. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the taxonomy:write scope.",
    "scope": "taxonomy:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "destructive",
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "list_tags",
    "operationId": "listTags",
    "method": "GET",
    "path": "/tags",
    "tag": "Tags",
    "summary": "List tags",
    "description": "List tags. Every tag on the Site, alphabetically. Tags are cross cutting: an article may carry many. Read only. Nothing is changed. Needs a key carrying the taxonomy:read scope.",
    "scope": "taxonomy:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "fields",
        "in": "query",
        "required": false,
        "description": "Comma separated field allow list. Default projection: `id, name, slug, article_count`.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "create_tag",
    "operationId": "createTag",
    "method": "POST",
    "path": "/tags",
    "tag": "Tags",
    "summary": "Create a tag",
    "description": "Create a tag. `slug` is unique within the Site. A collision returns `409 SLUG_CONFLICT`. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the taxonomy:write scope.",
    "scope": "taxonomy:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": true,
    "ifMatch": false,
    "params": [
      {
        "name": "name",
        "in": "body",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "slug",
        "in": "body",
        "required": false,
        "description": "Derived from `name` when omitted.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "get_tag",
    "operationId": "getTag",
    "method": "GET",
    "path": "/tags/{id}",
    "tag": "Tags",
    "summary": "Read one tag",
    "description": "Read one tag. Read only. Nothing is changed. Needs a key carrying the taxonomy:read scope.",
    "scope": "taxonomy:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "update_tag",
    "operationId": "updateTag",
    "method": "PATCH",
    "path": "/tags/{id}",
    "tag": "Tags",
    "summary": "Update a tag",
    "description": "Update a tag. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the taxonomy:write scope.",
    "scope": "taxonomy:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": true,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "name",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "slug",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "delete_tag",
    "operationId": "deleteTag",
    "method": "DELETE",
    "path": "/tags/{id}",
    "tag": "Tags",
    "summary": "Delete a tag",
    "description": "Delete a tag. The tag is removed from every article that carried it. No article is deleted. PERMANENT: this deletes content from the customer's Site. There is no trash and no undo. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the taxonomy:write scope.",
    "scope": "taxonomy:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "destructive",
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "list_authors",
    "operationId": "listAuthors",
    "method": "GET",
    "path": "/authors",
    "tag": "Authors",
    "summary": "List authors",
    "description": "List authors. The byline roster for the Site. Read only. Nothing is changed. Needs a key carrying the authors:read scope.",
    "scope": "authors:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "fields",
        "in": "query",
        "required": false,
        "description": "Comma separated field allow list. Default projection: `id, name, bio, avatar_url, is_ai_generated, is_default, created_at`.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "create_author",
    "operationId": "createAuthor",
    "method": "POST",
    "path": "/authors",
    "tag": "Authors",
    "summary": "Create an author",
    "description": "Create an author. `is_ai_generated` marks a persona rather than a real person. It defaults to `true` because that is what the generation pipeline creates. Set it to `false` for a human byline, and be accurate about it: it is what your disclosure copy keys off. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the authors:write scope.",
    "scope": "authors:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": true,
    "ifMatch": false,
    "params": [
      {
        "name": "name",
        "in": "body",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "bio",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "avatar_url",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uri"
      },
      {
        "name": "is_ai_generated",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "boolean",
        "nullable": false
      },
      {
        "name": "is_default",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "boolean",
        "nullable": false
      }
    ]
  },
  {
    "tool": "get_author",
    "operationId": "getAuthor",
    "method": "GET",
    "path": "/authors/{id}",
    "tag": "Authors",
    "summary": "Read one author",
    "description": "Read one author. Read only. Nothing is changed. Needs a key carrying the authors:read scope.",
    "scope": "authors:read",
    "entitlement": "none",
    "publishable": true,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "update_author",
    "operationId": "updateAuthor",
    "method": "PATCH",
    "path": "/authors/{id}",
    "tag": "Authors",
    "summary": "Update an author",
    "description": "Update an author. Setting `is_default: true` clears the flag on whichever author held it, because a Site has at most one default byline. Setting it to `false` on the current default leaves the Site with none. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the authors:write scope.",
    "scope": "authors:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": true,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "name",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "bio",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      },
      {
        "name": "avatar_url",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true,
        "format": "uri"
      },
      {
        "name": "is_ai_generated",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "boolean",
        "nullable": false
      },
      {
        "name": "is_default",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "boolean",
        "nullable": false
      }
    ]
  },
  {
    "tool": "delete_author",
    "operationId": "deleteAuthor",
    "method": "DELETE",
    "path": "/authors/{id}",
    "tag": "Authors",
    "summary": "Delete an author",
    "description": "Delete an author. Articles by this author are not deleted. Their `author_id` becomes `null`, so they stay published and lose their byline. PERMANENT: this deletes content from the customer's Site. There is no trash and no undo. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the authors:write scope.",
    "scope": "authors:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "destructive",
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "list_media",
    "operationId": "listMedia",
    "method": "GET",
    "path": "/media",
    "tag": "Media",
    "summary": "List media assets",
    "description": "List media assets. The media library, newest first. Read only. Nothing is changed. Needs a secret key (wv_sk_) carrying the media:read scope.",
    "scope": "media:read",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "bucket",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "enum": [
          "blog-images",
          "author-avatars"
        ]
      },
      {
        "name": "fields",
        "in": "query",
        "required": false,
        "description": "Comma separated field allow list. Default projection: `id, bucket, url, file_name, mime_type, size_bytes, width, height, alt_text, created_at`.",
        "explode": false,
        "kind": "string",
        "nullable": false
      }
    ]
  },
  {
    "tool": "get_media",
    "operationId": "getMediaAsset",
    "method": "GET",
    "path": "/media/{id}",
    "tag": "Media",
    "summary": "Read one media asset",
    "description": "Read one media asset. Read only. Nothing is changed. Needs a secret key (wv_sk_) carrying the media:read scope.",
    "scope": "media:read",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "update_media",
    "operationId": "updateMediaAsset",
    "method": "PATCH",
    "path": "/media/{id}",
    "tag": "Media",
    "summary": "Update a media asset",
    "description": "Update a media asset. Only `alt_text` is editable. The bytes are immutable: to replace an image, upload a new one and repoint whatever referenced the old one. Changes content on the customer's Site. Nothing becomes public: publishing is always a separate call. Needs a secret key (wv_sk_) carrying the media:write scope.",
    "scope": "media:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": true,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      },
      {
        "name": "alt_text",
        "in": "body",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": true
      }
    ]
  },
  {
    "tool": "delete_media",
    "operationId": "deleteMediaAsset",
    "method": "DELETE",
    "path": "/media/{id}",
    "tag": "Media",
    "summary": "Delete a media asset",
    "description": "Delete a media asset. Removes the catalog row and the stored bytes. PERMANENT: this deletes content from the customer's Site. There is no trash and no undo. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the media:write scope.",
    "scope": "media:write",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "destructive",
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "list_pipeline_runs",
    "operationId": "listPipelineRuns",
    "method": "GET",
    "path": "/pipeline/runs",
    "tag": "Pipeline",
    "summary": "List pipeline runs",
    "description": "List pipeline runs. Recent engine activity for the Site, newest first. One row per stage invocation, so a single logical run appears as several rows as work moves through the stages. Read only. Nothing is changed. Needs a secret key (wv_sk_) carrying the pipeline:read scope.",
    "scope": "pipeline:read",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "status",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "enum": [
          "running",
          "success",
          "failed",
          "partial"
        ]
      },
      {
        "name": "stage",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "enum": [
          "dispatch",
          "discover",
          "scrape",
          "extract",
          "plan",
          "generate",
          "improve",
          "classify",
          "images",
          "publish"
        ]
      }
    ]
  },
  {
    "tool": "trigger_pipeline_run",
    "operationId": "createPipelineRun",
    "method": "POST",
    "path": "/pipeline/runs",
    "tag": "Pipeline",
    "summary": "Request a pipeline run",
    "description": "Request a pipeline run. This is the only billable operation in this API. COSTS MONEY: this spends the organisation's credit balance. It is the only billable tool here, and it is charged per unit of work the engine completes. Ask the user before calling this, and pass confirm: true only once they have agreed. Needs a secret key (wv_sk_) carrying the pipeline:run scope.",
    "scope": "pipeline:run",
    "entitlement": "ai.article_generation",
    "publishable": false,
    "spendsCredits": true,
    "makesPublic": false,
    "readOnly": false,
    "confirm": true,
    "confirmReason": "spend",
    "idempotency": true,
    "ifMatch": false,
    "params": [
      {
        "name": "max_articles",
        "in": "body",
        "required": false,
        "description": "An upper bound on how many articles this run may produce. Your own safety valve on top of the platform spend cap. Omit to use the Site's configured batch size.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      }
    ]
  },
  {
    "tool": "get_pipeline_status",
    "operationId": "getPipelineRun",
    "method": "GET",
    "path": "/pipeline/runs/{id}",
    "tag": "Pipeline",
    "summary": "Read one pipeline run",
    "description": "Read one pipeline run. The outcome of a run. `status: partial` with an `error_summary` is what you see when a run stopped early, whether because credits ran out, the spend cap was reached, or a vendor call failed. `items_succeeded` tells you what you did get. Read only. Nothing is changed. Needs a secret key (wv_sk_) carrying the pipeline:read scope.",
    "scope": "pipeline:read",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "id",
        "in": "path",
        "required": true,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "format": "uuid"
      }
    ]
  },
  {
    "tool": "get_pipeline_queue",
    "operationId": "listPipelineQueue",
    "method": "GET",
    "path": "/pipeline/queue",
    "tag": "Pipeline",
    "summary": "Read the content queue",
    "description": "Read the content queue. What the engine plans to write, highest priority first. Each item is a topic or keyword with a source: `manual` if a person added it, `content_gap` if gap analysis found it, `competitor_seed` if it came from a competitor page. Read only. Nothing is changed. Needs a secret key (wv_sk_) carrying the pipeline:read scope.",
    "scope": "pipeline:read",
    "entitlement": "none",
    "publishable": false,
    "spendsCredits": false,
    "makesPublic": false,
    "readOnly": true,
    "confirm": false,
    "confirmReason": null,
    "idempotency": false,
    "ifMatch": false,
    "params": [
      {
        "name": "cursor",
        "in": "query",
        "required": false,
        "description": "The opaque cursor from `data.next_cursor` on the previous page. Do not parse it or construct one; its encoding is not part of this contract and will change.",
        "explode": false,
        "kind": "string",
        "nullable": false
      },
      {
        "name": "limit",
        "in": "query",
        "required": false,
        "description": "Page size. Values above the maximum are clamped rather than rejected, so a client asking for a thousand rows gets a hundred and a `next_cursor`.",
        "explode": false,
        "kind": "integer",
        "nullable": false
      },
      {
        "name": "status",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "enum": [
          "planned",
          "in_progress",
          "done",
          "skipped"
        ]
      },
      {
        "name": "source",
        "in": "query",
        "required": false,
        "description": "",
        "explode": false,
        "kind": "string",
        "nullable": false,
        "enum": [
          "content_gap",
          "manual",
          "competitor_seed"
        ]
      }
    ]
  }
];

export const REFUSALS: McpRefusal[] = [
  {
    "operationId": "registerMedia",
    "method": "POST",
    "path": "/media",
    "tag": "Media",
    "reason": "Reached through the upload_media tool, which drives the whole upload handshake in one call."
  },
  {
    "operationId": "createMediaUploadUrl",
    "method": "POST",
    "path": "/media/upload-url",
    "tag": "Media",
    "reason": "Reached through the upload_media tool, which drives the whole upload handshake in one call."
  },
  {
    "operationId": "listApiKeys",
    "method": "GET",
    "path": "/keys",
    "tag": "API keys",
    "reason": "Credential management stays in the dashboard. A server that can mint a secret key is a server whose compromise mints secret keys, and the key it would use to do so is sitting in a config file on the same machine."
  },
  {
    "operationId": "createApiKey",
    "method": "POST",
    "path": "/keys",
    "tag": "API keys",
    "reason": "Credential management stays in the dashboard. A server that can mint a secret key is a server whose compromise mints secret keys, and the key it would use to do so is sitting in a config file on the same machine."
  },
  {
    "operationId": "rotateApiKey",
    "method": "POST",
    "path": "/keys/{id}/rotate",
    "tag": "API keys",
    "reason": "Credential management stays in the dashboard. A server that can mint a secret key is a server whose compromise mints secret keys, and the key it would use to do so is sitting in a config file on the same machine."
  },
  {
    "operationId": "revokeApiKey",
    "method": "DELETE",
    "path": "/keys/{id}",
    "tag": "API keys",
    "reason": "Credential management stays in the dashboard. A server that can mint a secret key is a server whose compromise mints secret keys, and the key it would use to do so is sitting in a config file on the same machine."
  },
  {
    "operationId": "listWebhooks",
    "method": "GET",
    "path": "/webhooks",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "createWebhook",
    "method": "POST",
    "path": "/webhooks",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "getWebhook",
    "method": "GET",
    "path": "/webhooks/{id}",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "updateWebhook",
    "method": "PATCH",
    "path": "/webhooks/{id}",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "deleteWebhook",
    "method": "DELETE",
    "path": "/webhooks/{id}",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "rotateWebhookSecret",
    "method": "POST",
    "path": "/webhooks/{id}/rotate-secret",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "listWebhookDeliveries",
    "method": "GET",
    "path": "/webhooks/{id}/deliveries",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "redeliverWebhookDelivery",
    "method": "POST",
    "path": "/webhooks/{id}/deliveries/{delivery_id}/redeliver",
    "tag": "Webhooks",
    "reason": "Account configuration, not content. An assistant that can repoint delivery URLs can quietly redirect a Site's event stream, and that is a change a person should make deliberately."
  },
  {
    "operationId": "startDeviceAuthorization",
    "method": "POST",
    "path": "/auth/device",
    "tag": "Device sign-in",
    "reason": "Reached through the login tool, which drives the whole device sign-in in one call."
  },
  {
    "operationId": "pollDeviceAuthorization",
    "method": "POST",
    "path": "/auth/device/token",
    "tag": "Device sign-in",
    "reason": "Reached through the login tool, which drives the whole device sign-in in one call."
  }
];
