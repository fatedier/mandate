import { expect, test } from "bun:test";
import { workerPaneHref, workerInThreadHref } from "../../src/client/lib/worker-href.js";

// Seven call sites used to spell these paths by hand; the helpers must produce
// exactly what they did, with every segment encoded on its own.
test("workerPaneHref encodes the project, worker and pane segments each on its own", () => {
  expect(workerPaneHref("md-proj", "feat a", "%12")).toBe("/projects/md-proj/workers/feat%20a/pane/%2512");
  expect(workerPaneHref("md proj", "feat/a#1", "%3")).toBe("/projects/md%20proj/workers/feat%2Fa%231/pane/%253");
});

// A worker opens in its owner thread's panel; the tab, when named, is the
// page it opens on.
test("workerInThreadHref is the owner thread with the worker, and its tab when named", () => {
  expect(workerInThreadHref("thr 1", "feat/a#1")).toBe("/threads/thr%201?worker=feat%2Fa%231");
  expect(workerInThreadHref("thr_1", "wkr_a", "terminal")).toBe("/threads/thr_1?worker=wkr_a&tab=terminal");
});
