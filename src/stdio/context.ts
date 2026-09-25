import { toolContext, type CoreOptions } from "../core/server.js";
import type { ToolContext } from "../core/context.js";
import { CONFIG, USER_AGENT, apiKey, noKeyMessage } from "../config.js";

/**
 * The stdio host's options for the core: the key is whatever config.ts says is active at the
 * moment of the call (WRITAVO_API_KEY, else the saved sign-in, else none), so `login` and `logout`
 * take effect on the very next tool call with no restart.
 */
export function stdioOptions(): CoreOptions {
  return {
    apiKey: () => apiKey() || null,
    apiBase: CONFIG.apiBaseUrl,
    userAgent: USER_AGENT,
    host: "stdio",
  };
}

/** The same context the stdio server's tools run with, for the sign-in flow and the tests. */
export const STDIO_CONTEXT: ToolContext = toolContext(stdioOptions(), noKeyMessage);

/** A context that sends one specific key, whatever is active: for acting on the saved sign-in's own key. */
export function contextForKey(key: string, tool?: string): ToolContext {
  return { ...STDIO_CONTEXT, apiKey: () => key, ...(tool ? { tool } : {}) };
}
