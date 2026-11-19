// NW.js can't resolve bare ES-module specifiers such as "fs"; reach Node through
// the page's global require instead.

type NodeFs = typeof import("fs");

/** Node's fs module, or undefined outside NW.js (e.g. a plain browser). */
export function nodeFs(): NodeFs | undefined {
  const req = (globalThis as { require?: (m: string) => unknown }).require;
  return req ? (req("fs") as NodeFs) : undefined;
}
