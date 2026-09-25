/**
 * NON-NEGOTIABLE 2: a raw key must never reach stdout, stderr or an error message. Every string
 * this server emits passes through here, so a key that ends up somewhere by accident, in a URL an
 * API echoed back or in a stack trace, is masked on the way out rather than relied upon never to
 * arrive.
 *
 * The pattern catches every Writavo key by shape, which is all a hosted server needs. The stdio
 * host additionally registers the exact secrets it has held (rememberSecret), so a key is masked
 * even in a form the pattern would not recognise. In a Worker nothing is registered: a set of
 * every tenant's keys held in one isolate is precisely what must not exist.
 */
const secretsSeen = new Set<string>();

/** Register a secret with the redactor before it is ever active, as `login` does with a pending one. */
export function rememberSecret(secret: string): void {
  if (secret.length >= 8) secretsSeen.add(secret);
}

export function redact(text: string): string {
  // The negative lookahead is the same placeholder convention scripts/check-docs-drift.mjs uses
  // to tell a documented example from a real credential. Without it the instructions for someone
  // who has no key would have their own placeholder masked out.
  let out = text.replace(
    /wv_(sk|pub)_(?!your_|YOUR_|EXAMPLE|REDACTED)[A-Za-z0-9_-]{8,}/g,
    (_m, kind: string) => `wv_${kind}_REDACTED`,
  );
  for (const secret of secretsSeen) {
    out = out.split(secret).join("[redacted key]");
  }
  return out;
}
