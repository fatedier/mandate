import { expect, test } from "bun:test";
import { splitFileName } from "@/routes/window/changes/file-name";

// A row in the Changes list shows a file's name, then its directory. A long
// name is cut in the middle, so its end (the extension, a "_test" suffix)
// stays: the row renders `head` (which may be cut) and `tail` (never cut).

test("a long name keeps its last 12 characters whole", () => {
  expect(splitFileName("server/http/authentication_rate_limiter_with_sliding_window_test.go")).toEqual({
    base: "authentication_rate_limiter_with_sliding_window_test.go",
    head: "authentication_rate_limiter_with_sliding_wi",
    tail: "ndow_test.go",
    dir: "server/http"
  });
});

test("a name of up to 16 characters is never cut in the middle", () => {
  expect(splitFileName("pkg/limiter_test.go")).toEqual({ base: "limiter_test.go", head: "limiter_test.go", tail: null, dir: "pkg" });
  expect(splitFileName("src/abcdefghijklmnop")).toEqual({ base: "abcdefghijklmnop", head: "abcdefghijklmnop", tail: null, dir: "src" });
  // One more and it is cut.
  expect(splitFileName("src/abcdefghijklmnopq").tail).toBe("fghijklmnopq");
});

test("a file at the root has no directory", () => {
  expect(splitFileName("README.md")).toEqual({ base: "README.md", head: "README.md", tail: null, dir: null });
});

// Counted and cut by the characters a person sees (grapheme clusters), not
// UTF-16 units: a cut through a surrogate pair, a combining mark or a ZWJ
// sequence renders garbage in the two spans.
test("an emoji at the cut stays whole, and counts as one character", () => {
  expect(splitFileName("src/abcde😀abcdefghijk")).toEqual({ base: "abcde😀abcdefghijk", head: "abcde", tail: "😀abcdefghijk", dir: "src" });
  // Sixteen emoji are 32 UTF-16 units but 16 characters: not split.
  expect(splitFileName(`x/${"😀".repeat(16)}`).tail).toBe(null);
});

test("a combining mark stays with its letter, and a ZWJ sequence stays one character", () => {
  const accent = "é";
  expect(splitFileName(`src/abcde${accent}ghijklmnopq`)).toEqual({ base: `abcde${accent}ghijklmnopq`, head: "abcde", tail: `${accent}ghijklmnopq`, dir: "src" });
  const family = "👨‍👩‍👧";
  expect(splitFileName(`src/abcde${family}ghijklmnopq`).tail).toBe(`${family}ghijklmnopq`);
});
