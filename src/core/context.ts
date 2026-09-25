/**
 * Everything a tool needs to reach the API, carried per server instead of read from globals.
 *
 * The stdio server has one of these for its whole life. The hosted Worker builds a server per
 * request, many at once in one isolate and each for a different person's key, so nothing a tool
 * uses may live in module state: a key read from a global there would be somebody else's.
 */
export interface ToolContext {
  /** The key to send, or "" when there is none. Asked at the moment it is needed, never copied. */
  apiKey(): string;
  /** No trailing slash. */
  apiBase: string;
  userAgent: string;
  host: "stdio" | "remote";
  /** The reply a key-requiring tool gives when there is no key, with the host's own way to fix it. */
  notSignedIn(): string;
  /** The MCP tool making the request, sent as Writavo-Mcp-Tool. Set by forTool. */
  tool?: string;
  /**
   * Headers the host adds to every Writavo API request, asked once per request. The Worker sends
   * its own credential and the end user's IP here; they never replace a header the core set, and
   * never Authorization or Writavo-Mcp-Tool.
   */
  extraHeaders?: () => Record<string, string>;
}

/** The same context, labelled with the tool that is about to use it. */
export function forTool(ctx: ToolContext, tool: string): ToolContext {
  return { ...ctx, tool };
}

export const hasKey = (ctx: ToolContext): boolean => ctx.apiKey().length > 0;

export type KeyKind = "secret" | "publishable" | "unknown";

export function keyKindOf(ctx: ToolContext): KeyKind {
  const key = ctx.apiKey();
  if (key.startsWith("wv_sk_")) return "secret";
  if (key.startsWith("wv_pub_")) return "publishable";
  return "unknown";
}
