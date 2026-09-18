import { expect, test } from "bun:test";
import { buildReadPaneTool } from "../src/server/modules/panes/tools/read-pane.js";
import { PaneReadCursorStore } from "../src/server/modules/panes/pane-read-cursor.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../src/server/modules/agent/wake-message-adapter.js";
import type { StoredWatch } from "../src/server/modules/agent/window-watch-manager.js";

// Same shape as the harness in tool-read-pane-incremental.test.ts, plus a
// stubbed watchManager whose hasWatchForPane either returns a live watch or
// null depending on what the test wants to exercise. paneText is mutable via
// setScrollback so a test can drive multiple reads across changing content.
function harness(opts: { watchOnPane: boolean; paneText?: string }) {
  const threadId = "t1";
  let paneText = opts.paneText ?? "";
  const feature = { id: "f", projectId: "p", workingDir: "/tmp", tmuxWindowName: "w" } as any;
  const project = { id: "p", workingDir: "/tmp", tmuxSessionName: "s" } as any;
  const ctx = {
    threadId,
    wakeId: "w1",
    feature,
    project,
    paneRuntime: {
      readScrollback: async () => paneText,
      listPanes: async () => [{ id: "%1" }]
    }
  } as any;

  const watch: StoredWatch = {
    id: "watch-1",
    targetKey: "s:w:%1",
    ownerThreadId: threadId,
    windowKey: "s:w",
    paneId: "%1",
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

  const cursors = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors, watchManager });
  return {
    ctx,
    tool,
    cursors,
    watch,
    setScrollback: (text: string) => {
      paneText = text;
    }
  };
}

async function readPane(opts: { watchOnPane: boolean; paneText: string }): Promise<string> {
  const { ctx, tool } = harness(opts);
  return (await tool.handler({ paneId: "%1" }, ctx)) as string;
}

test("with a live watch the note appears AND the content still comes back", async () => {
  // Both halves. Asserting only that the note is present would be satisfied by
  // an implementation that returned the note and dropped the pane output.
  const out = await readPane({ watchOnPane: true, paneText: "build output here" });
  expect(out).toContain("already have a watch");
  expect(out).toContain("build output here");
});

test("with no watch the note does not appear", async () => {
  const out = await readPane({ watchOnPane: false, paneText: "build output here" });
  expect(out).not.toContain("already have a watch");
  expect(out).toContain("build output here");
});

test("the watch note does not tell an agent to register a watch", async () => {
  // IDLE_NUDGE_AFTER's text says "register watch_window". Saying that to an
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
  expect(second).toContain("already have a watch");
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
  expect(fourth).toContain("already have a watch");
});

test("when the capture exceeds the inline result limit, the note still appears", async () => {
  // The over-the-inline-cap return (>64KB or >2000 lines, about to be
  // spooled to a file by the dispatcher) is the fourth content return and,
  // like the idle-nudge branch, nothing above ever drives a read big enough
  // to reach it.
  const bigText = Array.from({ length: 2200 }, (_, i) => `line ${i}`).join("\n");
  const out = await readPane({ watchOnPane: true, paneText: `${bigText}\n` });
  expect(out).toContain("already have a watch");
  expect(out).toContain("line 2199");
});

test("with collapsed.text exactly at the inline line-count threshold, the note's added line tips it into the spooled branch", async () => {
  // exceedsInlineToolResultLimits checks `> 2000 lines`. Exactly 2000 lines is
  // NOT over that threshold on its own — but withWatchNote prefixes one more
  // line (the note itself), which makes finalText 2001 lines. The "exceeds
  // the inline result limit" test above uses 2200 lines, which is already
  // past the threshold before the note is even counted — a mutation that
  // checks exceedsInlineToolResultLimits(collapsed.text) instead of
  // exceedsInlineToolResultLimits(finalText) takes the same branch either
  // way there, so that fixture cannot tell the two conditions apart. This
  // one sits exactly on the line the two conditions disagree about.
  const lines = Array.from({ length: 2000 }, (_, i) => `line${i}`);
  const full = lines.join("\n");
  expect(full.split("\n").length).toBe(2000);

  const { ctx, tool, cursors } = harness({ watchOnPane: true, paneText: `${full}\n` });
  const out = await tool.handler({ paneId: "%1" }, ctx) as string;

  // Both halves: the note is present, and none of the pane content was lost
  // at this layer (spooling to a preview happens downstream in the
  // dispatcher, not inside read_pane itself).
  expect(out).toContain("already have a watch");
  expect(out).toContain("line1999");

  // Spooled-branch behaviour: the cursor is forgotten, not remembered — this
  // is only true if the exceeds-check saw finalText's 2001 lines and took the
  // "about to be spooled" branch. If it checked collapsed.text's 2000 lines
  // instead, it would (wrongly) take the normal-content branch and remember
  // a cursor here.
  expect(cursors.get("t1", "%1")).toBeNull();
});

test("a note that pushes a near-cap read over 20000 chars does not let the cursor over-claim", async () => {
  // Regression test for the cursor-accounting bug: modelVisiblePartOf must be
  // handed the exact string the model receives (note included), not the bare
  // pane content, or it computes the wrong cut and the cursor ends up
  // claiming lines the agent was never shown.
  //
  // 200 lines of 99 chars each, joined by "\n" with no trailing newline:
  // length = 200*99 + 199 = 19999 — just under MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS
  // (20000) on its own. The watch note (measured at 144-146 chars depending on
  // the rendered digits) plus its separating "\n" adds >140 more, pushing the
  // real returned string to ~20144 chars — over the cap. A caller with no
  // watch would see this whole capture; a caller with one must not have the
  // cursor believe it did.
  const lineWidth = 99;
  const lineCount = 200;
  const lines = Array.from(
    { length: lineCount },
    (_, i) => `L${String(i).padStart(4, "0")} ${"x".repeat(lineWidth - 6)}`
  );
  expect(lines[0]!.length).toBe(lineWidth);
  const full = lines.join("\n");
  expect(full.length).toBeLessThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  const lastLine = lines[lines.length - 1]!;
  const { ctx, tool, cursors } = harness({ watchOnPane: true, paneText: `${full}\n` });

  const first = await tool.handler({ paneId: "%1" }, ctx) as string;
  // Confirm the premise: the note really did push the actual returned string
  // over the cap that wake-message-adapter.ts applies at wake time.
  expect(first.length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(first).toContain("already have a watch");

  // The cursor must not have recorded the tail that got cut off — in
  // particular, not the very last line of the capture.
  const entry = cursors.get("t1", "%1");
  expect(entry).not.toBeNull();
  expect(entry!.lines.has(lastLine)).toBe(false);

  // Confirmed behaviourally too: reading the SAME content again must still
  // show the last line as new, not swallow it into "no new output" — which
  // is exactly what would happen if the cursor had wrongly claimed to have
  // already shown it.
  const second = await tool.handler({ paneId: "%1" }, ctx) as string;
  expect(second).toContain(lastLine);
});
