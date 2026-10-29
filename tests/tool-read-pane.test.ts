import { expect, test } from "bun:test";
import { alreadyWatchingNote, buildReadPaneTool, idleNudge } from "../src/server/modules/panes/tools/read-pane.js";
import { PaneReadCursorStore } from "../src/server/modules/panes/pane-read-cursor.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../src/server/modules/agent/wake-message-adapter.js";
import type { StoredWatch } from "../src/server/modules/agent/window-watch-manager.js";
import type { FeatureRow } from "../src/server/modules/features/features-store.js";
import type { ProjectRow } from "../src/server/modules/projects/projects-store.js";
import type { Pane } from "../src/server/runtime/pane-runtime.js";
import type { TmuxRuntime } from "../src/server/runtime/runtimes/tmux-runtime.js";
import { stub, toolContext } from "./helpers/typed.js";

// A worker's read_pane on feature f, whose one pane %1 shows paneText
// (setScrollback changes it between reads). Given watchOnPane, the tool also
// has a stubbed watchManager whose hasWatchForPane returns a live watch on %1
// for this thread, or null; without it the tool has no watchManager at all.
function harness(opts: { threadId?: string; paneText?: string; watchOnPane?: boolean; cursors?: PaneReadCursorStore } = {}) {
  const threadId = opts.threadId ?? "t1";
  let paneText = opts.paneText ?? "";
  let lastReadOptions: unknown;
  const feature = stub<FeatureRow>({ id: "f", projectId: "p", worktreePath: "/tmp", tmuxWindowName: "w" });
  const project = stub<ProjectRow>({ id: "p", workingDir: "/tmp", tmuxSessionName: "s" });
  const ctx = toolContext({
    threadId,
    wakeId: "w1",
    scope: { kind: "worker", feature: { workingDir: "/tmp" }, project: { workingDir: "/tmp" } },
    feature,
    project,
    paneRuntime: stub<TmuxRuntime>({
      readScrollback: async (_paneId: string, options: unknown) => {
        lastReadOptions = options;
        return paneText;
      },
      listPanes: async () => [stub<Pane>({ id: "%1" })]
    })
  });

  const watch: StoredWatch = {
    id: "watch-1",
    targetKey: "s:w:%1",
    ownerThreadId: threadId,
    windowKey: "s:w",
    paneId: "%1",
    paneName: null,
    stableMs: 30_000,
    note: "",
    createdAtMs: Date.now() - 5_000,
    timeoutMs: 1_000_000,
    timeoutAtMs: Date.now() + 1_000_000,
    // Never actually scheduled — this fixture is never passed to a real
    // WindowWatchManager, so a live timer here would just be a leak.
    timeoutTimer: 0 as unknown as ReturnType<typeof setTimeout>
  };

  const watchManager = {
    hasWatchForPane: (askedThreadId: string, askedPaneId: string) =>
      opts.watchOnPane && askedThreadId === threadId && askedPaneId === "%1" ? watch : null
  };

  const cursors = opts.cursors ?? new PaneReadCursorStore();
  const tool = buildReadPaneTool(opts.watchOnPane === undefined ? { cursors } : { cursors, watchManager });
  return {
    ctx,
    tool,
    cursors,
    watch,
    setScrollback: (text: string) => {
      paneText = text;
    },
    lastReadOptions: () => lastReadOptions
  };
}

async function readPane(opts: { watchOnPane: boolean; paneText: string }): Promise<string> {
  const { ctx, tool } = harness(opts);
  return (await tool.handler({ paneId: "%1" }, ctx)) as string;
}

test("read_pane: first read returns everything, second collapses the seen head", async () => {
  const h = harness();
  const { tool } = h;
  h.setScrollback("building...\nstep 3/8\n");
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe("building...\nstep 3/8");

  h.setScrollback("building...\nstep 3/8\nstep 4/8\n");
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(
    "… 2 lines unchanged since your last read of this pane\nstep 4/8"
  );
});

test("read_pane: the cursor tracks the full capture, not the collapsed output", async () => {
  const h = harness();
  const { tool } = h;
  h.setScrollback("a\nb\n");
  await tool.handler({ paneId: "%1" }, h.ctx);
  h.setScrollback("a\nb\nc\n");
  await tool.handler({ paneId: "%1" }, h.ctx);
  // Third read adds nothing: if the cursor had only kept the collapsed text,
  // "a" and "b" would look unseen again and come back.
  h.setScrollback("a\nb\nc\n");
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(
    "no new output in %1 since your last read (3 lines unchanged)"
  );
});

test("read_pane: a capture over the inline limit, cut to a preview at the call, leaves no cursor behind", async () => {
  const h = harness();
  const { tool, cursors: shared } = h;
  const lines = Array.from({ length: 600 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(50)}`);
  h.setScrollback(`${lines.join("\n")}\n`);

  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  // The dispatcher swaps this for a 2,000-character preview and a file: the
  // agent saw almost none of it, so no line is claimed as seen.
  expect(first.length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(shared.get("t1", "%1")).toBeNull();
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(first);
});

test("read_pane: a collapsed read still remembers the head it hid, past the inline limit of capture", async () => {
  const h = harness();
  const { tool } = h;
  const head = Array.from({ length: 450 }, (_, i) => `head ${String(i).padStart(4, "0")} ${"h".repeat(50)}`);
  const tail = Array.from({ length: 200 }, (_, i) => `tail ${String(i).padStart(4, "0")} ${"t".repeat(50)}`);
  h.setScrollback(`${head.join("\n")}\n`);
  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  expect(first.length).toBeLessThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  h.setScrollback(`${[...head, ...tail].join("\n")}\n`);
  const second = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  // The capture is over the cap, but the payload the agent gets is not: the
  // head was replaced by one marker line. Nothing here is invisible, so the
  // cursor must keep all 650 lines.
  expect([...head, ...tail].join("\n").length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(second.length).toBeLessThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(
    "no new output in %1 since your last read (650 lines unchanged)"
  );
});

test("read_pane: a result the dispatcher will spool to disk leaves no cursor behind", async () => {
  const h = harness();
  const { tool, cursors: shared } = h;
  const big = Array.from({ length: 1200 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n");
  h.setScrollback(`${big}\n`);

  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  // Over the inline limit: the dispatcher replaces this with a preview plus
  // a file path, so almost none of these lines reach the agent at all.
  expect(first.length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(shared.get("t1", "%1")).toBeNull();
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(big);
});

test("read_pane: many short lines under the inline limit reach the agent whole and are remembered", async () => {
  const h = harness();
  const { tool, cursors: shared } = h;
  const many = Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n");
  h.setScrollback(`${many}\n`);

  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  // Characters are the one measure: 2,100 short lines are sent whole.
  expect(first.split("\n").length).toBeGreaterThan(2000);
  expect(first.length).toBeLessThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(shared.get("t1", "%1")).not.toBeNull();
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe("no new output in %1 since your last read (2100 lines unchanged)");
});

test("read_pane: different threads keep independent cursors", async () => {
  const shared = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors: shared });
  const a = harness({ threadId: "t1" });
  const b = harness({ threadId: "t2" });
  a.setScrollback("a\nb\n");
  b.setScrollback("a\nb\n");
  await tool.handler({ paneId: "%1" }, a.ctx);
  expect(await tool.handler({ paneId: "%1" }, b.ctx)).toBe("a\nb");
});

test("read_pane: a pane outside the feature errors without writing a cursor", async () => {
  const h = harness();
  const { tool, cursors: shared } = h;
  h.setScrollback("a\nb\n");
  const r = await tool.handler({ paneId: "%99" }, h.ctx);
  if (typeof r === "string") throw new Error(`expected a scope error, got: ${r}`);
  expect(r.error).toContain("not in this feature");
  expect(shared.get("t1", "%99")).toBeNull();
});

test("read_pane: asks the runtime for `lines` tail lines, 200 when unspecified", async () => {
  const h = harness();
  const { tool } = h;
  h.setScrollback("a\n");
  await tool.handler({ paneId: "%1" }, h.ctx);
  expect(h.lastReadOptions()).toEqual({ tailLines: 200 });
  await tool.handler({ paneId: "%1", lines: 40 }, h.ctx);
  expect(h.lastReadOptions()).toEqual({ tailLines: 40 });
});

test("read_pane: nudges toward a pane monitor only after three idle reads in a row", async () => {
  const h = harness({ threadId: "t-nudge" });
  const { tool } = h;
  h.setScrollback("a\n");
  await tool.handler({ paneId: "%1" }, h.ctx);               // streak 0

  const second = await tool.handler({ paneId: "%1" }, h.ctx) as string;  // streak 1
  expect(second).not.toContain("monitor with a pane");

  const third = await tool.handler({ paneId: "%1" }, h.ctx) as string;   // streak 2
  expect(third).not.toContain("monitor with a pane");

  const fourth = await tool.handler({ paneId: "%1" }, h.ctx) as string;  // streak 3
  expect(fourth).toContain("no new output in %1");
  expect(fourth).toContain("This pane has not changed across your last 3 reads.");
  // A pane monitor is a settle detector, not a change detector: the nudge must
  // promise a wake once the pane is quiet, not a wake when it changes.
  expect(fourth).toContain(
    "monitor with a pane wakes you once a pane has been quiet for a set duration, "
    + "so register it when you start long-running work in a pane instead of re-reading it."
  );
  expect(fourth).not.toContain("when it changes");

  h.setScrollback("a\nb\n");
  const fifth = await tool.handler({ paneId: "%1" }, h.ctx) as string;   // streak resets
  expect(fifth).not.toContain("monitor with a pane");
});

test("with a live watch the note appears AND the content still comes back", async () => {
  // Both halves. Asserting only that the note is present would be satisfied by
  // an implementation that returned the note and dropped the pane output.
  const out = await readPane({ watchOnPane: true, paneText: "build output here" });
  expect(out).toContain("already have a monitor");
  expect(out).toContain("build output here");
});

test("with no watch the note does not appear", async () => {
  const out = await readPane({ watchOnPane: false, paneText: "build output here" });
  expect(out).not.toContain("already have a monitor");
  expect(out).toContain("build output here");
});

test("the watch note does not tell an agent to register a watch", async () => {
  // IDLE_NUDGE_AFTER's text says "register it" (a pane monitor). Saying that to an
  // agent that already has one is the non-answer this note exists to replace,
  // and both can fire on the same read.
  const out = await readPane({ watchOnPane: true, paneText: "x" });
  expect(out).not.toContain("so register it when you start long-running work");
});

test("with no new content since the last read, the note still appears", async () => {
  // read_pane has a return for "nothing new since your last read" that is
  // separate from the normal-content return above (and from the idle-nudge
  // wording, which only kicks in after IDLE_NUDGE_AFTER reads in a row).
  // A fixture whose first read is the only one exercised, like the tests
  // above, never reaches this branch — a helper dropped only here would
  // pass all of them. Two reads of identical content forces it, while
  // staying under IDLE_NUDGE_AFTER so the "has not changed across your
  // last N reads" wording never enters the picture.
  const { ctx, tool } = harness({ watchOnPane: true, paneText: "steady\n" });
  await tool.handler({ paneId: "%1" }, ctx);
  const second = await tool.handler({ paneId: "%1" }, ctx) as string;
  expect(second).toContain("no new output");
  expect(second).toContain("already have a monitor");
});

test("once the idle nudge fires (three unchanged reads), the note still appears", async () => {
  // The idle-nudge return (IDLE_NUDGE_AFTER reads in a row with no new
  // content) is a fourth, distinct return path from the plain "no new
  // content" one above — reached only after three identical reads. Neither
  // of the two tests above ever gets a streak that high, so a helper
  // dropped only on this branch would still pass all of them.
  const { ctx, tool } = harness({ watchOnPane: true, paneText: "steady\n" });
  await tool.handler({ paneId: "%1" }, ctx); // streak 0 (first read, always "new")
  await tool.handler({ paneId: "%1" }, ctx); // streak 1
  await tool.handler({ paneId: "%1" }, ctx); // streak 2
  const fourth = await tool.handler({ paneId: "%1" }, ctx) as string; // streak 3, nudge fires
  expect(fourth).toContain("This pane has not changed across your last 3 reads.");
  expect(fourth).toContain("already have a monitor");
});

test("when the capture exceeds the inline result limit, the note still appears", async () => {
  // The over-the-inline-cap return (over 30,000 characters, about to be
  // saved to a file by the dispatcher) is the fourth content return and,
  // like the idle-nudge branch, nothing above ever drives a read big enough
  // to reach it.
  const bigText = Array.from({ length: 600 }, (_, i) => `line ${i} ${"z".repeat(50)}`).join("\n");
  const out = await readPane({ watchOnPane: true, paneText: `${bigText}\n` });
  expect(out.length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(out).toContain("already have a monitor");
  expect(out).toContain("line 599");
});

test("with collapsed.text exactly at the inline limit, the note tips it into the saved-to-a-file branch", async () => {
  // exceedsInlineToolResultLimits checks `> 30,000 characters`. Exactly
  // 30,000 is NOT over it on its own, but withWatchNote prefixes the note,
  // which takes finalText past it. A mutation that checks collapsed.text
  // instead of finalText takes the other branch here, and only here.
  const lines = Array.from({ length: 300 }, (_, i) => `L${String(i).padStart(4, "0")} ${"x".repeat(93)}`);
  lines[299] = `${lines[299]}x`;
  const full = lines.join("\n");
  expect(full.length).toBe(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  const { ctx, tool, cursors } = harness({ watchOnPane: true, paneText: `${full}\n` });
  const out = await tool.handler({ paneId: "%1" }, ctx) as string;

  // The note is there, and none of the pane content was lost at this layer
  // (the cut to a preview happens downstream, in the dispatcher).
  expect(out).toContain("already have a monitor");
  expect(out).toContain(lines[299]!);
  // The cursor is forgotten, not remembered: the agent gets only a preview.
  expect(cursors.get("t1", "%1")).toBeNull();
});

test("a capture at the inline limit with no note reaches the agent whole and is remembered whole", async () => {
  const lines = Array.from({ length: 300 }, (_, i) => `L${String(i).padStart(4, "0")} ${"x".repeat(93)}`);
  lines[299] = `${lines[299]}x`;
  const full = lines.join("\n");
  expect(full.length).toBe(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  const { ctx, tool, cursors } = harness({ paneText: `${full}\n` });
  expect(await tool.handler({ paneId: "%1" }, ctx)).toBe(full);
  expect(cursors.get("t1", "%1")!.lines.has(lines[299]!)).toBe(true);
  expect(await tool.handler({ paneId: "%1" }, ctx)).toBe("no new output in %1 since your last read (300 lines unchanged)");
});

test("the nudges name monitor", () => {
  expect(idleNudge(3)).toContain("monitor with a pane wakes you once a pane has been quiet");
  expect(alreadyWatchingNote({ stableMs: 30_000, createdAtMs: 0 }, 5_000)).toMatch(/^You already have a monitor on this pane \(fires after 30s of quiet; registered 5s ago\)\./);
});
