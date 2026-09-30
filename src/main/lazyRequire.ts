import { createRequire } from "node:module";

const requireFromMain = createRequire(import.meta.url);

/**
 * A CommonJS dependency that is loaded on its first use instead of when the
 * main bundle starts. For dependencies only a few paths need (the updater,
 * YAML provider configs, Even G2 pairing, headless terminals): each of them
 * otherwise costs its import time on every launch. The load stays synchronous,
 * so callers keep their shape.
 */
export function lazyRequire<T>(specifier: string): () => T {
  let loaded: T | undefined;
  return () => (loaded ??= requireFromMain(specifier) as T);
}
