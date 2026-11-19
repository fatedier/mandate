import * as fs from "node:fs";
import { Language, Parser, type Node } from "web-tree-sitter";
import { logError } from "../logger.js";
// Both wasm files travel with the compiled binary (a `file` import is embedded
// by `bun build --compile`) and are read from wherever the build put them.
import runtimeWasmPath from "web-tree-sitter/tree-sitter.wasm" with { type: "file" };
import bashWasmPath from "tree-sitter-bash/tree-sitter-bash.wasm" with { type: "file" };

// A `file` import yields the file's path. bun-types (the tests' typecheck)
// types `*.wasm` as a module whatever the import attribute, so say it here.
const RUNTIME_WASM = runtimeWasmPath as unknown as string;
const BASH_WASM = bashWasmPath as unknown as string;

/** A bash command line as tree-sitter-bash read it. `hasError` is true when
 *  any part of it is an ERROR or MISSING node: the grammar could not read it
 *  in full, so nothing may be concluded from its other nodes. */
export interface BashTree {
  root: Node;
  hasError: boolean;
}

/** What an inspection may return: anything but a promise, since the tree is
 *  freed when the inspection returns and an awaited read would find it gone. */
export type Inspected<T> = T extends PromiseLike<unknown> ? never : T;

export interface BashParser {
  /** Parses `source` and hands the tree to `inspect`, then frees it: a tree
   *  holds wasm memory that nothing else frees, so it never outlives the
   *  inspection (synchronous, and keeping no node). Null when the parser is
   *  not available or gives no tree. */
  withTree<T>(source: string, inspect: (tree: BashTree) => Inspected<T>): Promise<T | null>;
}

/** The wasm runtime, one per process (web-tree-sitter keeps it in module
 *  state): set up once, and again only after a failed try. */
export interface BashRuntime {
  ensure(readFile: (path: string) => Uint8Array): Promise<void>;
}

let runtime: Promise<void> | null = null;

export const defaultBashRuntime: BashRuntime = {
  ensure(readFile) {
    runtime ??= Parser.init({ wasmBinary: readFile(RUNTIME_WASM) })
      .catch((err: unknown) => { runtime = null; throw err; });
    return runtime;
  }
};

/** A parser that loads on first use. A failed load is tried again once
 *  `retryAfterMs` has passed, not on every call. */
export function createBashParser(deps: {
  readFile: (path: string) => Uint8Array;
  now: () => number;
  retryAfterMs?: number;
  runtime?: BashRuntime;
}): BashParser {
  const retryAfterMs = deps.retryAfterMs ?? 60_000;
  const wasmRuntime = deps.runtime ?? defaultBashRuntime;
  let loading: Promise<Parser | null> | null = null;
  let failedAt: number | null = null;
  const attempt = async (): Promise<Parser | null> => {
    try {
      await wasmRuntime.ensure(deps.readFile);
      const bash = await Language.load(deps.readFile(BASH_WASM));
      failedAt = null;
      return new Parser().setLanguage(bash);
    } catch (err) {
      logError("bash parser", err);
      failedAt = deps.now();
      return null;
    }
  };
  const load = (): Promise<Parser | null> => {
    if (loading) return loading;
    if (failedAt !== null && deps.now() - failedAt < retryAfterMs) return Promise.resolve(null);
    // Begun only once `loading` holds it: a step that throws at once must
    // not leave a settled failure cached in its place.
    const current: Promise<Parser | null> = Promise.resolve().then(attempt).then((parser) => {
      if (!parser && loading === current) loading = null;
      return parser;
    });
    loading = current;
    return current;
  };
  return {
    async withTree<T>(source: string, inspect: (tree: BashTree) => Inspected<T>): Promise<T | null> {
      const parser = await load();
      const tree = parser?.parse(source) ?? null;
      if (!tree) return null;
      try {
        const result = inspect({ root: tree.rootNode, hasError: tree.rootNode.hasError });
        if (result !== null && typeof result === "object" && typeof (result as { then?: unknown }).then === "function") {
          throw new Error("A bash tree's inspection must be synchronous: the tree is freed when it returns.");
        }
        return result as T;
      } finally {
        tree.delete();
      }
    }
  };
}

const shared = createBashParser({ readFile: (path) => new Uint8Array(fs.readFileSync(path)), now: Date.now });

/** The process's parser: see BashParser.withTree. */
export function withBashTree<T>(source: string, inspect: (tree: BashTree) => Inspected<T>): Promise<T | null> {
  return shared.withTree(source, inspect);
}
