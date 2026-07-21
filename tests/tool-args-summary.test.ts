import { expect, test } from "bun:test";
import { isOpaqueId, summarizeArgs } from "../src/client/routes/window/chat/tool-args-summary.js";

// Synthetic examples cover opaque ID formats and readable values that must
// survive, including strings that resemble identifiers.
const OPAQUE = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "%70",
  "%266",
  "task_AbCd12Ef_Gh",
  "mem_JkLm34NoPqR",
  "cnv_StUv56WxYzA",
  "feat_BcDe78FgHiJ",
  // Generated identifiers can contain uppercase letters without any digits.
  "cnv_AbCdEfGhIjK"
];

const KEPT = [
  "feature/preference",
  "global/preference:editor-theme",
  "%42_zsh_/Users/alice/project",
  "read_only_mode",   // snake_case English, not a nanoid
  "pane_output",
  "used",
  "waiting",
  "implementing"
];

test("the opaque shapes are the three that actually occur", () => {
  for (const v of OPAQUE) expect(isOpaqueId(v)).toBe(true);
});

test("readable values survive, including the ones that look id-ish", () => {
  for (const v of KEPT) expect(isOpaqueId(v)).toBe(false);
});

test("only strings are ever opaque", () => {
  for (const v of [120, 0, true, null, undefined, {}, [], ["a"]]) {
    expect(isOpaqueId(v)).toBe(false);
  }
});

test("an opaque id is dropped while the rest of the call survives", () => {
  const summary = summarizeArgs({
    taskId: "11111111-1111-4111-8111-111111111111",
    status: "waiting",
    note: "Superseded by a higher-priority instruction"
  });
  expect(summary).not.toContain("11111111");
  // The positive half: dropping the id must not drop everything else.
  expect(summary).toContain("status=waiting");
  expect(summary).toContain("Superseded by a higher-priority instruction");
});

test("a call whose only argument is opaque summarises to nothing", () => {
  expect(summarizeArgs({ canvasId: "cnv_StUv56WxYzA" })).toBe("");
});

test("an all-string array reads as a command, not as JSON", () => {
  const summary = summarizeArgs({
    paneId: "%70",
    args: ["-l", "git status --short"]
  });
  expect(summary).toContain("git status --short");
  expect(summary).not.toContain("[");
  expect(summary).not.toContain('"');
  expect(summary).not.toContain("%70");
});

test("a mixed array keeps JSON, because space-joining it cannot be read back", () => {
  const summary = summarizeArgs({ items: [1, { a: 2 }] });
  expect(summary).toContain("[");
});

test("a primary key still speaks for itself", () => {
  expect(summarizeArgs({ command: "bun run test" })).toBe("bun run test");
});

test("a lone non-primary argument keeps its key, or it says nothing", () => {
  // `read_pane` is {paneId, lines}; with the pane id gone a bare "120" would
  // be worse than useless.
  expect(summarizeArgs({ paneId: "%70", lines: 120 })).toBe("lines=120");
});

test("an id-shaped key holding a readable value is not an id", () => {
  const summary = summarizeArgs({
    id: "feature/preference",
    outcome: "used",
    note: "Kept scope minimal"
  });
  expect(summary).toContain("feature/preference");
});

test("the summary is capped so a markdown body cannot fill the row", () => {
  const summary = summarizeArgs({ phase: "implementing", body: "x".repeat(5000) });
  expect(summary.length).toBeLessThanOrEqual(241); // 240 + the ellipsis
  expect(summary).toContain("phase=implementing");
  expect(summary.endsWith("…")).toBe(true);
});

test("a value that itself ends in `=` keeps its entry", () => {
  // Entries are dropped when their VALUE renders empty. Deciding that from the
  // joined `key=value` looks equivalent and is not — these two shapes both end
  // in `=` and both occur in an `update_my_work_item` body.
  const setext = summarizeArgs({ phase: "implementing", body: "## Progress\n====" });
  expect(setext).toContain("phase=implementing");
  expect(setext).toContain("## Progress");

  const padded = summarizeArgs({ status: "ok", data: "aGVsbG8=" });
  expect(padded).toContain("data=aGVsbG8=");
});

test("the cap never cuts a surrogate pair in half", () => {
  // Arranged so the 240th UTF-16 unit lands inside an emoji: a plain `slice`
  // ends the row on a lone high surrogate, which renders as a replacement glyph.
  const summary = summarizeArgs({ body: `${"x".repeat(234)}${"🙂".repeat(20)}` });
  expect(summary.length).toBeLessThanOrEqual(241);
  expect(/[\uD800-\uDBFF]$/.test(summary.slice(0, -1))).toBe(false);
});

test("the canvas fallback is used only when nothing else survives", () => {
  expect(summarizeArgs({ canvasId: "cnv_StUv56WxYzA" }, "Feature report")).toBe("Feature report");
  // It must not override a real summary.
  expect(summarizeArgs({ command: "bun run test" }, "Feature report")).toBe("bun run test");
});
