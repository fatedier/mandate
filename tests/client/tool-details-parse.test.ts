import { expect, test } from "bun:test";
import {
  bashArgs,
  editReplacements,
  editResult,
  isWriteSuccess,
  lineDiff,
  parseBashResult,
  parseNumberedLines,
  parsePaneRead,
  writeResult
} from "@/routes/window/chat/tool-details/parse";
import type { DiffLine } from "@shared/line-diff";
import { isLongText } from "@/routes/window/chat/tool-details/inline-cap";
import { keyPresses, pressesText } from "@/routes/window/chat/tool-details/keys";
import { formatBashResult } from "../../src/server/modules/agent/tools/bash.js";
import { formatReadLines } from "../../src/server/modules/agent/tools/read-file.js";
import { writeSummary } from "../../src/server/modules/agent/tools/write-file.js";
import { editSummary } from "../../src/server/modules/agent/tools/edit-file.js";
import { alreadyWatchingNote, idleNudge } from "../../src/server/modules/panes/tools/read-pane.js";
import { collapseSeenPrefix } from "../../src/server/modules/panes/pane-read-collapse.js";

// Round-tripped through the server's own formatter, so a change to the
// transcript's shape breaks here rather than silently in the view.
test.each([
  ["stdout and stderr", { stdout: "3 pass\n0 fail", stderr: "warning: slow test", exitCode: 0 }],
  ["stdout only", { stdout: "main.ts\nutil.ts", stderr: "", exitCode: 0 }],
  ["stderr only", { stdout: "", stderr: "ls: /nope: No such file", exitCode: 2 }],
  ["neither", { stdout: "", stderr: "", exitCode: 0 }],
  ["killed, no code of its own", { stdout: "", stderr: "[bash: command timed out after 1000ms]", exitCode: -1 }]
])("a bash transcript comes apart as it was written: %s", (_name, parts) => {
  expect(parseBashResult(formatBashResult(parts))).toEqual(parts);
});

// With no real stderr after it, a marker printed to stdout cannot be told from
// the real one; that case reads as stderr, and is left so.
test("the stderr marker a command prints to stdout stays in stdout when there is real stderr too", () => {
  const parts = { stdout: "a\nstderr:\nb", stderr: "real", exitCode: 1 };
  expect(parseBashResult(formatBashResult(parts))).toEqual(parts);
});

test("anything not in that shape is not taken apart", () => {
  expect(parseBashResult("stdout:\nhead of a long run… [truncated]")).toBe(null);
  expect(parseBashResult("Wrote 12 bytes to /tmp/x.\nexitCode: 0")).toBe(null);
  expect(parseBashResult({ stdout: "x" })).toBe(null);
  expect(parseBashResult(undefined)).toBe(null);
});

const show = (lines: DiffLine[]) => lines.map((l) => `${l.kind}${l.text}`);

test("a replaced line is removed then added, between the lines both share", () => {
  expect(show(lineDiff("a\nb\nc", "a\nB\nc").lines)).toEqual([" a", "-b", "+B", " c"]);
});

test("pure additions and removals keep the rest as context", () => {
  expect(show(lineDiff("a\nc", "a\nb\nc").lines)).toEqual([" a", "+b", " c"]);
  expect(show(lineDiff("a\nb\nc", "a\nc").lines)).toEqual([" a", "-b", " c"]);
  expect(show(lineDiff("same", "same").lines)).toEqual([" same"]);
});

// Every diff, however it is drawn, must be the old text and the new: context
// plus removals read the old lines in order, context plus additions the new.
function sides(lines: DiffLine[]) {
  return {
    before: lines.filter((l) => l.kind !== "+").map((l) => l.text),
    after: lines.filter((l) => l.kind !== "-").map((l) => l.text)
  };
}

/** Seeded digits in 32-bit integer steps (mulberry32). The obvious
 *  `seed * 1103515245 % 2 ** 31` overflows a double's 53 bits: its low bits
 *  go to zero, and every "random" list came out one letter. */
function digits(seed: number, base: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % base;
  };
}

test("any diff reads back as the two texts it was made from", () => {
  const next = digits(7, 4);
  let marked = 0;
  for (let round = 0; round < 200; round += 1) {
    const before = Array.from({ length: next() + next() }, () => "wxyz"[next()]!).join("\n");
    const after = Array.from({ length: next() + next() }, () => "wxyz"[next()]!).join("\n");
    const { lines, aligned } = lineDiff(before, after);
    expect(aligned).toBe(true);
    expect(sides(lines)).toEqual({ before: before.split("\n"), after: after.split("\n") });
    if (lines.some((l) => l.kind === "+") && lines.some((l) => l.kind === "-")) marked += 1;
  }
  // The inputs vary: most rounds both add and remove.
  expect(marked).toBeGreaterThan(80);
});

test("one line changed in a long text is aligned: the lines around it are set aside first", () => {
  const before = Array.from({ length: 600 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 600 }, (_, i) => (i === 300 ? "changed" : `old ${i}`)).join("\n");
  const { lines, aligned } = lineDiff(before, after);
  expect(aligned).toBe(true);
  expect(lines.filter((l) => l.kind !== " ").map((l) => `${l.kind}${l.text}`)).toEqual(["-old 300", "+changed"]);
});

test("a changed part too large to align is its old lines removed and its new added, the lines around it kept", () => {
  const before = ["same", ...Array.from({ length: 600 }, (_, i) => `old ${i}`), "end"].join("\n");
  const after = ["same", ...Array.from({ length: 600 }, (_, i) => `new ${i}`), "end"].join("\n");
  const { lines, aligned } = lineDiff(before, after);
  expect(aligned).toBe(false);
  expect(lines.filter((l) => l.kind === " ").map((l) => l.text)).toEqual(["same", "end"]);
  expect(sides(lines)).toEqual({ before: before.split("\n"), after: after.split("\n") });
});

test("an edit's count of places comes from its result, for the path it was asked for", () => {
  expect(editReplacements("Updated /repo/a.ts (1 replacement).", "/repo/a.ts")).toBe(1);
  expect(editReplacements("Updated /repo/my (draft) notes.md (12 replacements).", "/repo/my (draft) notes.md")).toBe(12);
  expect(editReplacements("Updated /repo/a.ts (1 replacement).", "/repo/b/../a.ts")).toBe(null);
  expect(editReplacements("Edited /repo/a.ts", "/repo/a.ts")).toBe(null);
  expect(editReplacements({ ok: true }, "/repo/a.ts")).toBe(null);
  // Counted or not, it is the same count of places.
  expect(editReplacements(editSummary("/repo/a.ts", 3, { added: 3, removed: 3 }), "/repo/a.ts")).toBe(3);
  expect(editReplacements(editSummary("/repo/a.ts", 3, { added: 3, removed: 3 }), "/repo/b/../a.ts")).toBe(null);
});

// Round-tripped through the server's own formatter.
test("an edit's result says the places it replaced and the lines it changed in the file", () => {
  const path = "/repo/my (draft)\nnotes.md";
  expect(editResult(editSummary(path, 1, { added: 1, removed: 2 }))).toEqual({ path, places: 1, changes: { added: 1, removed: 2 } });
  expect(editResult(editSummary(path, 12, null))).toEqual({ path, places: 12, changes: null });
  // From before edits counted lines.
  expect(editResult(`Updated ${path} (1 replacement).`)).toEqual({ path, places: 1, changes: null });
  expect(editResult("Updated /repo/a.ts")).toBe(null);
  expect(editResult(undefined)).toBe(null);
});

const presses = (args: string[]) => keyPresses(args)?.map((p) => `${p.kind}:${p.text}`) ?? null;

test("send_keys args read as tmux reads them, in the forms agents use", () => {
  expect(presses(["C-c"])).toEqual(["key:C-c"]);
  expect(presses(["codex", "Enter"])).toEqual(["typed:codex", "key:Enter"]);
  // After -l everything is literal, a key name included.
  expect(presses(["-l", "ls -la", "Enter"])).toEqual(["typed:ls -la", "typed:Enter"]);
  expect(presses(["M-x", "S-Tab", "BSpace", "F12", "F13", "enter", "y", "^C"])).toEqual([
    "key:M-x", "key:S-Tab", "key:BSpace", "key:F12", "typed:F13", "key:enter", "typed:y", "key:^C"
  ]);
  // Options end at the first argument that is not one: here -la is text.
  expect(presses(["ls", "-la", "Enter"])).toEqual(["typed:ls", "typed:-la", "key:Enter"]);
  expect(presses(["Enter", "-l", "x"])).toEqual(["key:Enter", "typed:-l", "typed:x"]);
  // `--` ends them too: what follows is keys and text, `-l` included.
  expect(presses(["--", "-l", "Enter"])).toEqual(["typed:-l", "key:Enter"]);
  expect(presses(["-"])).toEqual(["typed:-"]);
});

test("any other tmux option is not read: the call is shown as sent", () => {
  // Hex codes, repeats, copy-mode commands, clusters: a label would have to reimplement tmux.
  for (const args of [["-H", "41"], ["-N", "5", "Enter"], ["-X", "cancel"], ["-Hl", "41"], ["-l", "-H", "41"], ["-R"]]) {
    expect(presses(args)).toBe(null);
  }
});

test("presses read as one line the way tmux sends them", () => {
  const line = (args: string[]) => pressesText(keyPresses(args)!);
  expect(line(["-l", "bun run dev --port 4180"])).toBe('"bun run dev --port 4180"');
  expect(line(["bun run dev", "Enter"])).toBe('"bun run dev" Enter');
  expect(line(["C-c"])).toBe("C-c");
  // No space is added between arguments: this typed ls-la.
  expect(line(["ls", "-la", "Enter"])).toBe('"ls-la" Enter');
  expect(line(["-l", "a", "b"])).toBe('"ab"');
  expect(line(["Escape", ":wq", "Enter"])).toBe('Escape ":wq" Enter');
  expect(line(["-l", 'say "hi"\n'])).toBe('"say \\"hi\\"\\n"');
});

// Round-tripped through the server's own read_pane text, as bash's is.
const SEEN = new Set(["$ bun run dev", "ready in 612 ms"]);

test("a pane read comes apart into the screen and the notes around it", () => {
  const plain = "$ bun run dev\nready in 612 ms";
  expect(parsePaneRead(plain)).toEqual({ before: [], screen: plain, after: [] });

  const collapsed = collapseSeenPrefix("$ bun run dev\nready in 612 ms\nhmr update ChatInput.tsx", SEEN, { paneId: "%4" }).text;
  expect(parsePaneRead(collapsed)).toEqual({
    before: ["… 2 lines unchanged since your last read of this pane"],
    screen: "hmr update ChatInput.tsx",
    after: []
  });

  const watch = alreadyWatchingNote({ stableMs: 30_000, createdAtMs: 0 }, 5_000);
  expect(parsePaneRead(`${watch}\n${collapsed}`)).toEqual({
    before: [watch, "… 2 lines unchanged since your last read of this pane"],
    screen: "hmr update ChatInput.tsx",
    after: []
  });
});

test("a read with nothing new has no screen, only its notes", () => {
  const nothing = collapseSeenPrefix("$ bun run dev\nready in 612 ms", SEEN, { paneId: "%4" }).text;
  expect(parsePaneRead(nothing)).toEqual({ before: [nothing], screen: null, after: [] });
  const nudged = `${nothing}\n${idleNudge(3)}`;
  expect(parsePaneRead(nudged)).toEqual({ before: [nothing], screen: null, after: [idleNudge(3)] });
  // Anything after that is not the tool's own text: all of it is the screen.
  expect(parsePaneRead(`${nothing}\nsomething else`)).toEqual({ before: [], screen: `${nothing}\nsomething else`, after: [] });
});

test("a read result's lines come back with their numbers", () => {
  const file = "first\n\tindented\n42\tnot a number column\nlast";
  expect(parseNumberedLines(formatReadLines(file, 2, 2))).toEqual([
    { number: 2, text: "\tindented" },
    { number: 3, text: "42\tnot a number column" }
  ]);
  expect(parseNumberedLines(formatReadLines("only", undefined, undefined))).toEqual([{ number: 1, text: "only" }]);
  // A whole-file read cut to its first page says so first: the lines still read as lines.
  const long = Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n");
  const page = parseNumberedLines(formatReadLines(long, undefined, undefined))!;
  expect([page.length, page[0], page.at(-1)]).toEqual([2000, { number: 1, text: "l0" }, { number: 2000, text: "l1999" }]);
  expect(parseNumberedLines("[PARTIAL view: lines 1–2 of 9. Read more with offset and limit.]\nnot numbered")).toBe(null);
  expect(parseNumberedLines("no numbers here")).toBe(null);
  // Not how the server writes them: unpadded, or not one after another.
  expect(parseNumberedLines("1\tfirst\n2\tsecond")).toBe(null);
  expect(parseNumberedLines("     1\tfirst\n    99\tlast")).toBe(null);
  expect(parseNumberedLines("000001\ttext")).toBe(null);
  expect(parseNumberedLines("     9\tnine\n    10\tten")).toEqual([{ number: 9, text: "nine" }, { number: 10, text: "ten" }]);
  expect(parseNumberedLines({ error: "x" })).toBe(null);
});

test("a write's success text is recognised for the path it was asked for only", () => {
  expect(isWriteSuccess(writeSummary("/repo/index.html", "x\n", false, null), "/repo/index.html")).toBe(true);
  expect(isWriteSuccess(writeSummary("/repo/index.html", "x\n", true, { added: 1, removed: 0 }), "/repo/index.html")).toBe(true);
  expect(isWriteSuccess(writeSummary("/repo/index.html", "x\n", true, null), "/repo/../repo/index.html")).toBe(false);
  expect(isWriteSuccess("Wrote many bytes to /repo/index.html.", "/repo/index.html")).toBe(false);
  expect(isWriteSuccess(undefined, "/repo/index.html")).toBe(false);
});

// Round-tripped through the server's own formatter, as bash's is above.
test("a write's result says whether it created the file and the lines it changed", () => {
  const path = "/repo/my (draft) notes.md";
  expect(writeResult(writeSummary(path, "a\nb\n", false, null))).toEqual({ path, created: true, changes: { added: 2, removed: 0 } });
  expect(writeResult(writeSummary(path, "", false, null))).toEqual({ path, created: true, changes: { added: 0, removed: 0 } });
  expect(writeResult(writeSummary(path, "x", false, null))).toEqual({ path, created: true, changes: { added: 1, removed: 0 } });
  expect(writeResult(writeSummary(path, "a\nb\n", true, { added: 12, removed: 20 }))).toEqual({ path, created: false, changes: { added: 12, removed: 20 } });
  expect(writeResult(writeSummary(path, "a", true, { added: 1, removed: 1 }))).toEqual({ path, created: false, changes: { added: 1, removed: 1 } });
  // Too large to count, or the old text unreadable: overwritten, lines unknown.
  expect(writeResult(writeSummary(path, "a\nb\n", true, null))).toEqual({ path, created: false, changes: null });
  // The wording writes had before they said what they did reads as no write.
  expect(writeResult(`Wrote 5789 bytes to ${path}.`)).toBeNull();
  // A newline is as good as any other character in a path.
  const odd = "/repo/two\nlines.md";
  expect(writeResult(writeSummary(odd, "x", false, null))?.path).toBe(odd);
  expect(writeResult(writeSummary(odd, "x", true, { added: 1, removed: 0 }))?.path).toBe(odd);
  expect(writeResult(writeSummary(odd, "x", true, null))?.path).toBe(odd);
  expect(writeResult("Wrote many bytes to /repo/a.md.")).toBe(null);
  expect(writeResult("Created /repo/a.md.")).toBe(null);
  expect(writeResult({ ok: true })).toBe(null);
});

test("text is long past 800 characters or 24 lines, whichever comes first", () => {
  expect(isLongText("x".repeat(800))).toBe(false);
  expect(isLongText("x".repeat(801))).toBe(true);
  expect(isLongText(Array.from({ length: 24 }, () => "x").join("\n"))).toBe(false);
  expect(isLongText(Array.from({ length: 25 }, () => "x").join("\n"))).toBe(true);
  // Two hundred one-character lines: short in characters, a tall block.
  expect(isLongText(Array.from({ length: 200 }, () => "x").join("\n"))).toBe(true);
});

test("a bash call run in the background still reads as bash", () => {
  expect(bashArgs({ command: "make e2e", description: "Run the e2e suite", run_in_background: true })).toEqual({ command: "make e2e", description: "Run the e2e suite", run_in_background: true });
  expect(bashArgs({ command: "make e2e", run_in_background: "yes" })).toBeNull();
});
