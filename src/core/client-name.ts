/**
 * The name a person sees for the app that holds a key (MCP-2 Addendum B, "Which app holds which
 * key"). An MCP client names itself in the initialize handshake (clientInfo.name), and an OAuth
 * client in its registration; both are raw identifiers like "claude-code" or "Visual Studio Code".
 * Settings > API keys and Settings > AI agents show the friendly form, so a person can tell that
 * Claude Code or Codex already holds a key.
 *
 * Pure and runtime-agnostic: the stdio login uses it for the device sign-in, the hosted Worker for
 * dynamically registered clients. The name is the client's own CLAIM, never proof of identity.
 */

const KNOWN: [RegExp, string][] = [
  [/^claude[-_ ]?code/i, "Claude Code"],
  [/^codex/i, "Codex"],
  [/^cursor/i, "Cursor"],
  [/^(visual studio code|vscode)/i, "VS Code"],
  [/^claude[-_ ]?ai$/i, "Claude"],
  [/^windsurf/i, "Windsurf"],
  [/^zed/i, "Zed"],
];

export const FALLBACK_CLIENT_NAME = "AI assistant";
const MAX = 60;

/** Printable ASCII only, whitespace collapsed, at most 60 characters. */
function sanitise(raw: string): string {
  return raw
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX)
    .trim();
}

export function friendlyClientName(raw?: string | null): string {
  if (typeof raw !== "string") return FALLBACK_CLIENT_NAME;
  const clean = sanitise(raw);
  if (!clean) return FALLBACK_CLIENT_NAME;
  for (const [pattern, name] of KNOWN) if (pattern.test(clean)) return name;
  return clean;
}
