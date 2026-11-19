import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { createBashParser, defaultBashRuntime, withBashTree } from "../src/server/platform/shell/bash-parser.js";

// The fast path proves a command safe only from a tree the grammar read in
// full: a line it misreads must say so rather than look like clean commands.

test("a plain pipeline parses with no error", async () => {
  const seen = await withBashTree("ls -la | wc -l", (tree) => ({ hasError: tree.hasError, type: tree.root.type }));
  expect(seen).toEqual({ hasError: false, type: "program" });
});

test("a line the grammar misreads is marked as an error, never as two clean commands", async () => {
  expect(await withBashTree("echo ==; rm -rf x", (tree) => tree.hasError)).toBe(true);
});

// A tree holds wasm memory nothing else frees: it lives only while it is
// inspected, so a long-running server never accumulates them.
test("what the inspection returns comes back, and an inspection that throws still lets the next parse work", async () => {
  await expect(withBashTree("ls", () => { throw new Error("inspect failed"); })).rejects.toThrow("inspect failed");
  expect(await withBashTree("pwd", (tree) => tree.root.childCount)).toBe(1);
});

// A load that failed once (a file read refused, say) is tried again later
// rather than turning parsing off for the life of the process.
test("a parser whose first load failed loads on a later try", async () => {
  let clock = 0;
  let refuse = true;
  const parser = createBashParser({
    readFile: (path) => {
      if (refuse && path.endsWith("tree-sitter-bash.wasm")) { refuse = false; throw new Error("EMFILE"); }
      return new Uint8Array(fs.readFileSync(path));
    },
    now: () => clock,
    retryAfterMs: 60_000
  });
  expect(await parser.withTree("ls", (tree) => tree.hasError)).toBeNull();
  expect(await parser.withTree("ls", (tree) => tree.hasError)).toBeNull();
  clock = 60_000;
  expect(await parser.withTree("ls", (tree) => tree.hasError)).toBe(false);
});

test("a parser whose wasm runtime failed at once, before any wait, loads on a later try", async () => {
  let clock = 0;
  let refuse = true;
  const parser = createBashParser({
    readFile: (path) => new Uint8Array(fs.readFileSync(path)),
    now: () => clock,
    retryAfterMs: 60_000,
    runtime: {
      ensure: (readFile) => {
        if (refuse) { refuse = false; throw new Error("EMFILE"); }
        return defaultBashRuntime.ensure(readFile);
      }
    }
  });
  expect(await parser.withTree("ls", (tree) => tree.hasError)).toBeNull();
  clock = 60_000;
  expect(await parser.withTree("ls", (tree) => tree.hasError)).toBe(false);
});

// The tree is freed when the inspection returns: one that awaits first would
// read freed memory, so the types refuse it and the parser throws on it.
test("an inspection that returns a promise is refused", async () => {
  const asyncInspect = async (tree: { hasError: boolean }) => tree.hasError;
  // @ts-expect-error an async inspection would read a freed tree
  await expect(withBashTree("ls", asyncInspect)).rejects.toThrow("synchronous");
});
