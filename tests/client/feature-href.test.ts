import { expect, test } from "bun:test";
import { featureHref, featurePaneHref } from "../../src/client/lib/feature-href.js";

// Seven call sites used to spell these paths by hand; the helpers must produce
// exactly what they did, with every segment encoded on its own.
test("featureHref encodes the project and feature segments", () => {
  expect(featureHref("md proj", "feat/a#1")).toBe("/projects/md%20proj/features/feat%2Fa%231");
});

test("featurePaneHref is the feature route plus an encoded pane segment", () => {
  expect(featurePaneHref("md-proj", "feat a", "%12")).toBe("/projects/md-proj/features/feat%20a/pane/%2512");
  expect(featurePaneHref("p", "f", "%3")).toBe(`${featureHref("p", "f")}/pane/${encodeURIComponent("%3")}`);
});
