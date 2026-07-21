import { expect, test } from "bun:test";
import { buildReadPaneTool } from "../src/server/modules/panes/tools/read-pane.js";
import { PaneReadCursorStore } from "../src/server/modules/panes/pane-read-cursor.js";
import { MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS } from "../src/server/modules/agent/wake-message-adapter.js";

function harness(threadId = "t1") {
  let scrollback = "";
  let lastReadOptions: unknown;
  const feature = { id: "f", projectId: "p", workingDir: "/tmp", tmuxWindowName: "w" } as any;
  const project = { id: "p", workingDir: "/tmp", tmuxSessionName: "s" } as any;
  const ctx = {
    threadId,
    wakeId: "w1",
    feature,
    project,
    paneRuntime: {
      readScrollback: async (_paneId: string, options: unknown) => {
        lastReadOptions = options;
        return scrollback;
      },
      listPanes: async () => [{ id: "%1" }]
    }
  } as any;
  return {
    ctx,
    setScrollback: (text: string) => {
      scrollback = text;
    },
    lastReadOptions: () => lastReadOptions
  };
}

const cursors = () => new PaneReadCursorStore();

test("read_pane: first read returns everything, second collapses the seen head", async () => {
  const tool = buildReadPaneTool({ cursors: cursors() });
  const h = harness();
  h.setScrollback("building...\nstep 3/8\n");
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe("building...\nstep 3/8");

  h.setScrollback("building...\nstep 3/8\nstep 4/8\n");
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(
    "… 2 lines unchanged since your last read of this pane\nstep 4/8"
  );
});

test("read_pane: the cursor tracks the full capture, not the collapsed output", async () => {
  const tool = buildReadPaneTool({ cursors: cursors() });
  const h = harness();
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

test("read_pane: never remembers lines the 20k tool-result cap hides from the model", async () => {
  const tool = buildReadPaneTool({ cursors: cursors() });
  const h = harness();
  const lines = Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, "0")} ${"x".repeat(50)}`);
  h.setScrollback(`${lines.join("\n")}\n`);

  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  expect(first.length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  // Same capture again. The head of the first result reached the agent; its
  // tail was cut off before the model ever saw it, so the tail is still new.
  const second = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  expect(second).not.toContain("no new output");
  expect(second).toContain(lines[399]!);

  const collapsed = Number(/… (\d+) lines unchanged/.exec(second)?.[1]);
  expect(collapsed).toBeGreaterThan(0);
  expect(collapsed).toBeLessThan(400);
  // The invariant, stated directly: every line we claim as seen has to be
  // inside the slice of the previous result the model was actually given.
  const modelSaw = first.slice(0, MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(modelSaw).toContain(lines[collapsed - 1]!);
  // ...and we stop at the first line it cut, rather than forgetting more.
  expect(modelSaw).not.toContain(lines[collapsed]!);
});

test("read_pane: a collapsed read still remembers the head it hid, past 20k of capture", async () => {
  const tool = buildReadPaneTool({ cursors: cursors() });
  const h = harness();
  const head = Array.from({ length: 300 }, (_, i) => `head ${String(i).padStart(4, "0")} ${"h".repeat(50)}`);
  const tail = Array.from({ length: 200 }, (_, i) => `tail ${String(i).padStart(4, "0")} ${"t".repeat(50)}`);
  h.setScrollback(`${head.join("\n")}\n`);
  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  expect(first.length).toBeLessThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  h.setScrollback(`${[...head, ...tail].join("\n")}\n`);
  const second = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  // The capture is over the cap, but the payload the agent gets is not: the
  // head was replaced by one marker line. Nothing here is invisible, so the
  // cursor must keep all 500 lines.
  expect([...head, ...tail].join("\n").length).toBeGreaterThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);
  expect(second.length).toBeLessThan(MODEL_VISIBLE_TOOL_RESULT_MAX_CHARS);

  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(
    "no new output in %1 since your last read (500 lines unchanged)"
  );
});

test("read_pane: a result the dispatcher will spool to disk leaves no cursor behind", async () => {
  const shared = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors: shared });
  const h = harness();
  const big = Array.from({ length: 1200 }, (_, i) => `line ${i} ${"y".repeat(60)}`).join("\n");
  h.setScrollback(`${big}\n`);

  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  // Over 64KB: the dispatcher replaces this with a preview plus a file path,
  // so almost none of these lines reach the agent at all.
  expect(Buffer.byteLength(first, "utf8")).toBeGreaterThan(64 * 1024);
  expect(shared.get("t1", "%1")).toBeNull();
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(big);
});

test("read_pane: a result over the spool line limit also leaves no cursor behind", async () => {
  const shared = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors: shared });
  const h = harness();
  const many = Array.from({ length: 2100 }, (_, i) => `l${i}`).join("\n");
  h.setScrollback(`${many}\n`);

  const first = await tool.handler({ paneId: "%1" }, h.ctx) as string;
  expect(Buffer.byteLength(first, "utf8")).toBeLessThan(64 * 1024);
  expect(first.split("\n").length).toBeGreaterThan(2000);
  expect(shared.get("t1", "%1")).toBeNull();
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe(many);
});

test("read_pane: different threads keep independent cursors", async () => {
  const shared = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors: shared });
  const a = harness("t1");
  const b = harness("t2");
  a.setScrollback("a\nb\n");
  b.setScrollback("a\nb\n");
  await tool.handler({ paneId: "%1" }, a.ctx);
  expect(await tool.handler({ paneId: "%1" }, b.ctx)).toBe("a\nb");
});

test("read_pane: a pane outside the feature errors without writing a cursor", async () => {
  const shared = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors: shared });
  const h = harness();
  h.setScrollback("a\nb\n");
  const r = await tool.handler({ paneId: "%99" }, h.ctx);
  expect((r as any).error).toContain("not in this feature");
  expect(shared.get("t1", "%99")).toBeNull();
});

test("read_pane: resetThread restores full output", async () => {
  const shared = new PaneReadCursorStore();
  const tool = buildReadPaneTool({ cursors: shared });
  const h = harness();
  h.setScrollback("a\nb\n");
  await tool.handler({ paneId: "%1" }, h.ctx);
  shared.resetThread("t1");
  expect(await tool.handler({ paneId: "%1" }, h.ctx)).toBe("a\nb");
});

test("read_pane: asks the runtime for `lines` tail lines, 200 when unspecified", async () => {
  const tool = buildReadPaneTool({ cursors: cursors() });
  const h = harness();
  h.setScrollback("a\n");
  await tool.handler({ paneId: "%1" }, h.ctx);
  expect(h.lastReadOptions()).toEqual({ tailLines: 200 });
  await tool.handler({ paneId: "%1", lines: 40 }, h.ctx);
  expect(h.lastReadOptions()).toEqual({ tailLines: 40 });
});

test("read_pane: nudges toward watch_window only after three idle reads in a row", async () => {
  const tool = buildReadPaneTool({ cursors: new PaneReadCursorStore() });
  const h = harness("t-nudge");
  h.setScrollback("a\n");
  await tool.handler({ paneId: "%1" }, h.ctx);               // streak 0

  const second = await tool.handler({ paneId: "%1" }, h.ctx) as string;  // streak 1
  expect(second).not.toContain("watch_window");

  const third = await tool.handler({ paneId: "%1" }, h.ctx) as string;   // streak 2
  expect(third).not.toContain("watch_window");

  const fourth = await tool.handler({ paneId: "%1" }, h.ctx) as string;  // streak 3
  expect(fourth).toContain("no new output in %1");
  expect(fourth).toContain("This pane has not changed across your last 3 reads.");
  // watch_window is a settle detector, not a change detector: the nudge must
  // promise a wake once the pane is quiet, not a wake when it changes.
  expect(fourth).toContain(
    "watch_window wakes you once a pane has been quiet for a set duration, "
    + "so register it when you start long-running work in a pane instead of re-reading it."
  );
  expect(fourth).not.toContain("when it changes");

  h.setScrollback("a\nb\n");
  const fifth = await tool.handler({ paneId: "%1" }, h.ctx) as string;   // streak resets
  expect(fifth).not.toContain("watch_window");
});
