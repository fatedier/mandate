import { expect, test } from "bun:test";
import { fileRoute, fileTargetOf, fileTargetOfSearch, isImagePath } from "@/lib/file-link";

// Which links in an agent's text are files: an absolute path that is none of
// the app's pages, or a file:// address; a line after #L, or after a colon.

test("an absolute path that is no page of the app is a file; the app's pages, relative paths and web addresses are not", () => {
  expect(fileTargetOf("/home/dev/notes.md")).toEqual({ path: "/home/dev/notes.md" });
  expect(fileTargetOf("/Users/dev/project-1/docs/report.md")).toEqual({ path: "/Users/dev/project-1/docs/report.md" });
  for (const href of ["/home", "/agent", "/duty", "/canvas/cnv_AaAaAaAaAa1", "/threads", "/threads/thr_1", "/projects", "/file", "src/a.ts", "./a.md", "https://example.com/a.md", "//example.com/a", "", null, undefined]) {
    expect([href, fileTargetOf(href)]).toEqual([href, null]);
  }
});

test("a file:// address names its path, decoded; one on another host does not", () => {
  expect(fileTargetOf("file:///tmp/a%20b.md")).toEqual({ path: "/tmp/a b.md" });
  expect(fileTargetOf("file://localhost/tmp/x.md#L3")).toEqual({ path: "/tmp/x.md", line: 3 });
  expect(fileTargetOf("file://server/share/x.md")).toBeNull();
  expect(fileTargetOf("/tmp/%E4%B8%AD%E6%96%87.md")).toEqual({ path: "/tmp/中文.md" });
});

test("lines: #L42, #L42-L60, a :42 ending; any other fragment is dropped", () => {
  expect(fileTargetOf("/a/b.ts#L42")).toEqual({ path: "/a/b.ts", line: 42 });
  expect(fileTargetOf("/a/b.ts#L42-L60")).toEqual({ path: "/a/b.ts", line: 42, end: 60 });
  expect(fileTargetOf("/a/b.ts#L42-60")).toEqual({ path: "/a/b.ts", line: 42, end: 60 });
  expect(fileTargetOf("/a/b.ts:42")).toEqual({ path: "/a/b.ts", line: 42 });
  expect(fileTargetOf("/a/b.ts:42:7")).toEqual({ path: "/a/b.ts", line: 42 });
  expect(fileTargetOf("/a/notes.md#intro")).toEqual({ path: "/a/notes.md" });
  expect(fileTargetOf("/a/b.ts#L0")).toEqual({ path: "/a/b.ts" });
});

test("a file's page address carries its path and lines, and reads back", () => {
  const target = { path: "/tmp/a b/中文.md", line: 42, end: 60 };
  const route = fileRoute(target);
  expect(route.startsWith("/file?")).toBe(true);
  expect(fileTargetOfSearch(route.slice("/file".length))).toEqual(target);
  expect(fileTargetOfSearch(fileRoute({ path: "/tmp/x.md" }).slice(5))).toEqual({ path: "/tmp/x.md" });
  expect(fileTargetOfSearch("?path=relative.md")).toBeNull();
  expect(fileTargetOfSearch("")).toBeNull();
});

test("images are told by their extension", () => {
  expect(["/a/s.png", "/a/s.JPG", "/a/s.svg", "/a/s.webp", "/a/s.md", "/a/png"].map(isImagePath)).toEqual([true, true, true, true, false, false]);
});

test("an app page with a query is the app's; a file's query is dropped", () => {
  expect(fileTargetOf("/settings?tab=voice")).toBeNull();
  expect(fileTargetOf("/memory?view=activity")).toBeNull();
  expect(fileTargetOf("/tmp/a.md?x=1")).toEqual({ path: "/tmp/a.md" });
});
