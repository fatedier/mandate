import { expect, test } from "bun:test";
import { collapseSeenPrefix, paneLineSet } from "../src/server/modules/panes/pane-read-collapse.js";

const OPTS = { paneId: "%175" };

test("collapseSeenPrefix: no cursor returns the input untouched", () => {
  const out = collapseSeenPrefix("a\nb\nc", null, OPTS);
  expect(out.text).toBe("a\nb\nc");
  expect(out.collapsedLines).toBe(0);
  expect(out.hasNew).toBe(true);
});

test("collapseSeenPrefix: pure append collapses the seen head only", () => {
  const seen = paneLineSet("building...\nstep 3/8");
  const out = collapseSeenPrefix("building...\nstep 3/8\nstep 4/8\n$ ", seen, OPTS);
  expect(out.collapsedLines).toBe(2);
  expect(out.hasNew).toBe(true);
  expect(out.text).toBe("… 2 lines unchanged since your last read of this pane\nstep 4/8\n$ ");
});

test("collapseSeenPrefix: full redraw collapses nothing", () => {
  const seen = paneLineSet("old-a\nold-b");
  const out = collapseSeenPrefix("new-a\nold-a\nold-b", seen, OPTS);
  expect(out.collapsedLines).toBe(0);
  expect(out.text).toBe("new-a\nold-a\nold-b");
  expect(out.hasNew).toBe(true);
});

test("collapseSeenPrefix: zero new output returns the idle marker", () => {
  const seen = paneLineSet("a\nb");
  const out = collapseSeenPrefix("a\nb", seen, OPTS);
  expect(out.hasNew).toBe(false);
  expect(out.collapsedLines).toBe(2);
  expect(out.text).toBe("no new output in %175 since your last read (2 lines unchanged)");
});

test("collapseSeenPrefix: a wider window exposes older unseen lines and collapses nothing", () => {
  const seen = paneLineSet("b\nc");
  const out = collapseSeenPrefix("a\nb\nc", seen, OPTS);
  expect(out.collapsedLines).toBe(0);
  expect(out.text).toBe("a\nb\nc");
});

test("collapseSeenPrefix: blank lines never block or count toward the collapsed head", () => {
  const seen = paneLineSet("a\nb");
  const out = collapseSeenPrefix("a\n\nb\n\nnew", seen, OPTS);
  expect(out.collapsedLines).toBe(2);
  expect(out.text).toBe("… 2 lines unchanged since your last read of this pane\nnew");
});

test("collapseSeenPrefix: trailing whitespace does not defeat the match", () => {
  const seen = paneLineSet("a   \nb");
  const out = collapseSeenPrefix("a\nb\nnew", seen, OPTS);
  expect(out.collapsedLines).toBe(2);
});

test("collapseSeenPrefix: an all-blank capture is returned untouched", () => {
  const seen = paneLineSet("a\nb");
  const out = collapseSeenPrefix("\n\n", seen, OPTS);
  expect(out.collapsedLines).toBe(0);
  expect(out.text).toBe("\n\n");
  expect(out.hasNew).toBe(true);
});

test("collapseSeenPrefix: a single collapsed line reads as singular", () => {
  const seen = paneLineSet("only");
  const out = collapseSeenPrefix("only\nfresh", seen, OPTS);
  expect(out.text).toBe("… 1 line unchanged since your last read of this pane\nfresh");
});

test("collapseSeenPrefix: a single idle line reads as singular", () => {
  const seen = paneLineSet("only");
  const out = collapseSeenPrefix("only", seen, OPTS);
  expect(out.text).toBe("no new output in %175 since your last read (1 line unchanged)");
});

test("collapseSeenPrefix: new output that repeats an old line still counts it collapsed", () => {
  const seen = paneLineSet("done\nready");
  // "done" is genuinely new output here, but it is indistinguishable from the
  // earlier "done". Pinning the behaviour: it joins the collapsed head, and the
  // marker count stays truthful about how many lines were dropped.
  const out = collapseSeenPrefix("done\nready\ndone\nfresh", seen, OPTS);
  expect(out.collapsedLines).toBe(3);
  expect(out.text).toBe("… 3 lines unchanged since your last read of this pane\nfresh");
});

test("paneLineSet: drops blanks and trailing whitespace", () => {
  expect([...paneLineSet("a  \n\n b\n")]).toEqual(["a", " b"]);
});
