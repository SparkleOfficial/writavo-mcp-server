import { apiRequest } from "../api/client.js";
import type { McpOperation } from "../generated/operations.js";
import { forTool, hasKey, keyKindOf, type ToolContext } from "../core/context.js";
import { formatApiError, publishableKeyRefusal, text, toolError, type ToolResult } from "../errors.js";

export type ToolArgs = Record<string, unknown>;

/**
 * What a tool says when it is asked to do something outward facing and nobody has said yes yet.
 *
 * API-6 §2 "Confirmation": publishing to a live site, deleting content and spending credits are
 * not one shot actions. The reply describes the consequence in the words the person needs to
 * agree to, and nothing has happened at the point it is returned.
 */
function confirmationRequired(operation: McpOperation, args: ToolArgs): ToolResult {
  const target = typeof args.id === "string" ? ` (${args.id})` : "";
  const consequence =
    operation.confirmReason === "spend"
      ? "This spends the organisation's credit balance. The engine is charged per unit of work it completes, and the amount depends on what is in the queue."
      : operation.confirmReason === "destructive"
        ? "This permanently deletes content from the customer's Site. There is no trash and no undo."
        : operation.confirmReason === "approval"
          ? "This takes live content down from the customer's Site: readers and search engines stop seeing it."
          : "This makes content publicly visible on the customer's own live site, where search engines and readers will see it.";

  return text(
    [
      `Nothing has been done. ${operation.tool}${target} needs the user to confirm first.`,
      "",
      consequence,
      "",
      `Ask the user whether to go ahead. If they agree, call ${operation.tool} again with confirm: true.`,
    ].join("\n"),
  );
}

/**
 * Invoke one generated operation. Every tool except upload_media and get_api_docs is this
 * function bound to a different row of the generated table, which is what makes a new endpoint in
 * openapi.yaml a working tool with no code behind it.
 */
export async function callOperation(ctx: ToolContext, operation: McpOperation, rawArgs: ToolArgs): Promise<ToolResult> {
  const args = rawArgs ?? {};

  if (!hasKey(ctx)) return toolError(ctx.notSignedIn());

  if (keyKindOf(ctx) === "publishable" && !operation.publishable) {
    return publishableKeyRefusal(operation.tool, operation.scope);
  }

  if (operation.confirm && args.confirm !== true) {
    return confirmationRequired(operation, args);
  }

  let path = operation.path;
  const query: [string, string][] = [];
  const body: Record<string, unknown> = {};

  for (const param of operation.params) {
    const value = args[param.name];
    if (value === undefined) {
      if (param.required && param.in === "path") {
        return toolError(`${operation.tool} needs ${param.name}.`);
      }
      continue;
    }

    if (param.in === "path") {
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(value)));
      continue;
    }
    if (param.in === "query") {
      if (Array.isArray(value)) {
        // `style: form, explode: true` in the spec: repeat the parameter rather than joining it.
        for (const item of value) query.push([param.name, String(item)]);
      } else if (value !== null) {
        query.push([param.name, String(value)]);
      }
      continue;
    }
    body[param.name] = value;
  }

  if (path.includes("{")) {
    return toolError(`${operation.tool} is missing a path argument: ${path}.`);
  }

  const headers: Record<string, string> = {};
  if (operation.idempotency) {
    // Generated here rather than asked of the model. A model that invents one reuses it, and a
    // reused key with a different body is a 409 rather than the retry safety it exists to give.
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  if (operation.ifMatch && typeof args.if_match === "string" && args.if_match.length > 0) {
    headers["If-Match"] = args.if_match;
  }
  if (operation.approval && typeof args.approval_id === "string" && args.approval_id.length > 0) {
    // The retry of a request a person has approved. The API matches it to the approval by method,
    // path and exact body, so nothing else about the request may differ from the first call.
    headers["Writavo-Approval"] = args.approval_id;
  }

  try {
    const response = await apiRequest<unknown>(forTool(ctx, operation.tool), {
      method: operation.method,
      path,
      query,
      body: operation.method === "GET" || operation.method === "DELETE" ? undefined : body,
      headers,
    });

    if (response.status === 204) {
      return text(`${operation.summary}: done. The API returned no content, which is the success case here.`);
    }

    const lines = [`${operation.summary}: done.`];
    if (response.etag) {
      lines.push(`ETag ${response.etag}. Pass it as if_match on your next write to this object.`);
    }
    lines.push("", JSON.stringify(response.data, null, 2));
    return text(lines.join("\n"));
  } catch (err) {
    return formatApiError(err, {
      tool: operation.tool,
      scope: operation.scope,
      entitlement: operation.entitlement,
    });
  }
}
