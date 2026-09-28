/**
 * NON-NEGOTIABLE 2: a raw key must never reach a log line or an error message. Every string this
 * server emits passes through here, so a key that ends up somewhere by accident, in a URL an API
 * echoed back or in a stack trace, is masked on the way out rather than relied upon never to
 * arrive.
 *
 * The pattern catches every Writavo key by shape, which is all it needs. Nothing is remembered: a
 * set of every tenant's keys held in one Worker isolate is precisely what must not exist.
 */

export function redact(text: string): string {
  // The negative lookahead is the same placeholder convention scripts/check-docs-drift.mjs uses
  // to tell a documented example from a real credential. Without it the instructions for someone
  // who has no key would have their own placeholder masked out.
  return text.replace(
    /wv_(sk|pub)_(?!your_|YOUR_|EXAMPLE|REDACTED)[A-Za-z0-9_-]{8,}/g,
    (_m, kind: string) => `wv_${kind}_REDACTED`,
  );
}
