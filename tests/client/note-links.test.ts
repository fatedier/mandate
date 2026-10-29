import { expect, test } from "bun:test";
import { noteTokens, type NoteLinkContext } from "@/routes/window/plan/note-links";

const ctx: NoteLinkContext = {
  paneHref: (id) => `/projects/project-1/features/f/pane/${encodeURIComponent(id)}`,
  paneName: (id) => (id === "%133" ? "Codex review" : undefined),
  canvasTitle: (id) => (id === "cnv_AbCdEfGhIjK" ? "TTL analysis" : undefined),
  webBase: "https://github.com/acmecorp/project-1",
  maxStepId: 0
};

test("panes, reports, commits, issues and URLs become links; the rest stays text", () => {
  const tokens = noteTokens("ran in %133 and %9; see cnv_AbCdEfGhIjK, commit c0ffee1, #34, acmecorp/project-2#17, project-2#17, 100%5, https://ci.example.com/run/7.", ctx);
  expect(tokens.filter((t) => t.kind !== "text")).toEqual([
    { kind: "pane", paneId: "%133", label: "Codex review", href: "/projects/project-1/features/f/pane/%25133" },
    { kind: "pane", paneId: "%9", label: "%9", href: "/projects/project-1/features/f/pane/%259" },
    { kind: "canvas", canvasId: "cnv_AbCdEfGhIjK", label: "TTL analysis" },
    { kind: "web", label: "c0ffee1", href: "https://github.com/acmecorp/project-1/commit/c0ffee1" },
    { kind: "web", label: "#34", href: "https://github.com/acmecorp/project-1/issues/34" },
    { kind: "web", label: "acmecorp/project-2#17", href: "https://github.com/acmecorp/project-2/issues/17" },
    { kind: "web", label: "https://ci.example.com/run/7", href: "https://ci.example.com/run/7" }
  ]);
  expect(tokens.map((t) => (t.kind === "text" ? t.text : t.label)).join("")).toBe(
    "ran in Codex review and %9; see TTL analysis, commit c0ffee1, #34, acmecorp/project-2#17, project-2#17, 100%5, https://ci.example.com/run/7."
  );
});

test("without a web remote, commits and issue numbers stay text", () => {
  expect(noteTokens("commit c0ffee1 fixes #12", { ...ctx, webBase: null })).toEqual([{ kind: "text", text: "commit c0ffee1 fixes #12" }]);
});

test("a hex word needs a letter and two digits to count as a commit", () => {
  expect(noteTokens("1234567 and deadbee and face2face and 9f3c2a1", ctx).filter((t) => t.kind === "web").map((t) => t.label)).toEqual(["9f3c2a1"]);
});

test("a CSS colour is not a commit", () => {
  expect(noteTokens("set the border to #a1b2c3d4 and #0f3c2a1", ctx).filter((t) => t.kind === "web")).toEqual([]);
});

test("a URL keeps its own parentheses and leaves trailing punctuation as text", () => {
  const tokens = noteTokens("see https://en.wikipedia.org/wiki/Function_(mathematics). (and https://x.dev/a)", ctx);
  expect(tokens.filter((t) => t.kind === "web").map((t) => t.label)).toEqual([
    "https://en.wikipedia.org/wiki/Function_(mathematics)",
    "https://x.dev/a"
  ]);
  expect(tokens.map((t) => (t.kind === "text" ? t.text : t.label)).join("")).toBe("see https://en.wikipedia.org/wiki/Function_(mathematics). (and https://x.dev/a)");
});

test("a URL in Markdown backticks or brackets leaves the wrapper as text", () => {
  const tokens = noteTokens("ran `https://ci.example.com/run/7` and [https://x.dev/a] and [docs](https://x.dev/b)", ctx);
  expect(tokens.filter((t) => t.kind === "web").map((t) => t.label)).toEqual([
    "https://ci.example.com/run/7", "https://x.dev/a", "https://x.dev/b"
  ]);
  expect(tokens.map((t) => (t.kind === "text" ? t.text : t.label)).join("")).toBe("ran `https://ci.example.com/run/7` and [https://x.dev/a] and [docs](https://x.dev/b)");
});

test("a hash inside a file name or path is not a commit; one ending a sentence is", () => {
  const web = (note: string) => noteTokens(note, ctx).filter((t) => t.kind === "web").map((t) => t.label);
  expect(web("built dist/c0ffee1.js and c0ffee1.css and assets/c0ffee1")).toEqual([]);
  expect(web("fixed in c0ffee1.")).toEqual(["c0ffee1"]);
});

test("a Bitbucket remote links commits where Bitbucket serves them", () => {
  const tokens = noteTokens("see c0ffee1", { ...ctx, webBase: "https://bitbucket.org/team/app" });
  expect(tokens.filter((t) => t.kind === "web").map((t) => t.kind === "web" && t.href)).toEqual(["https://bitbucket.org/team/app/commits/c0ffee1"]);
});

test("#N within the plan's step ids is a step, not an issue, unless the note says PR or issue", () => {
  const web = (note: string) => noteTokens(note, { ...ctx, maxStepId: 5 }).filter((t) => t.kind === "web").map((t) => t.label);
  expect(web("blocked until #3 lands; see step #2")).toEqual([]);
  expect(web("opened PR #4, fixes issue #2 and pull request #5")).toEqual(["#4", "#2", "#5"]);
  expect(web("PR: #3, issue: #2, pull request (#4), MR(#5)")).toEqual(["#3", "#2", "#4", "#5"]);
  expect(web("PR: (#3) and issue - #2")).toEqual(["#3"]);
  expect(web("pull request:   (#3)")).toEqual(["#3"]);
  expect(web("upstream #34 and acmecorp/project-2#3")).toEqual(["#34", "acmecorp/project-2#3"]);
  expect(noteTokens("see #3", { ...ctx, maxStepId: 0 }).filter((t) => t.kind === "web").map((t) => t.label)).toEqual(["#3"]);
});

test("owner/repo#N needs a real owner: a number or a Go test name is not one", () => {
  const web = (note: string) => noteTokens(note, ctx).filter((t) => t.kind === "web").map((t) => t.label);
  // Shapes that read as owner/repo#N but are not: a number, or a Go test name, before the slash.
  expect(web("project-1 历史 PR#12/issue#34")).toEqual([]);
  expect(web("=== RUN FuzzDecodeFrame/seed#0; --- FAIL: TestParse/empty#01; BenchmarkDial/tcp#2; ExampleServe/basic#1")).toEqual([]);
  // Real references keep their links, dots in the name included.
  expect(web("see acmecorp/project-1#21, example-org/example.go#42, vercel/next.js#123 and Testcontainers/testcontainers-go#9")).toEqual([
    "acmecorp/project-1#21", "example-org/example.go#42", "vercel/next.js#123", "Testcontainers/testcontainers-go#9"
  ]);
});

test("a pane id against CJK text is still a pane", () => {
  expect(noteTokens("在%133里跑", ctx).filter((t) => t.kind === "pane").map((t) => t.label)).toEqual(["Codex review"]);
});

test("a pane with nowhere to go stays text", () => {
  expect(noteTokens("see %12", { ...ctx, paneHref: () => null })).toEqual([{ kind: "text", text: "see %12" }]);
});
