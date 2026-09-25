/**
 * The package version, as a constant rather than read from package.json at runtime: the core runs
 * inside a Cloudflare Worker too, where there is no package.json on a filesystem to read. The smoke
 * test asserts this equals package.json, so the two cannot drift.
 */
export const VERSION = "0.3.0";
