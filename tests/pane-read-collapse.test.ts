import { expect, test } from "bun:test";
import { collapseSeenPrefix, paneLineSet } from "../src/server/modules/panes/pane-read-collapse.js";

const OPTS = { paneId: "%175" };

// seen is what the last read showed (null: no cursor at all); out is the whole result.
const cases = [
  { name: "no cursor returns the input untouched", seen: null, capture: "a\nb\nc",
    out: { text: "a\nb\nc", collapsedLines: 0, hasNew: true } },
  { name: "pure append collapses the seen head only", seen: "building...\nstep 3/8", capture: "building...\nstep 3/8\nstep 4/8\n$ ",
    out: { text: "… 2 lines unchanged since your last read of this pane\nstep 4/8\n$ ", collapsedLines: 2, hasNew: true } },
  { name: "full redraw collapses nothing", seen: "old-a\nold-b", capture: "new-a\nold-a\nold-b",
    out: { text: "new-a\nold-a\nold-b", collapsedLines: 0, hasNew: true } },
  { name: "zero new output returns the idle marker", seen: "a\nb", capture: "a\nb",
    out: { text: "no new output in %175 since your last read (2 lines unchanged)", collapsedLines: 2, hasNew: false } },
  { name: "a wider window exposes older unseen lines and collapses nothing", seen: "b\nc", capture: "a\nb\nc",
    out: { text: "a\nb\nc", collapsedLines: 0, hasNew: true } },
  { name: "blank lines never block or count toward the collapsed head", seen: "a\nb", capture: "a\n\nb\n\nnew",
    out: { text: "… 2 lines unchanged since your last read of this pane\nnew", collapsedLines: 2, hasNew: true } },
  { name: "trailing whitespace does not defeat the match", seen: "a   \nb", capture: "a\nb\nnew",
    out: { text: "… 2 lines unchanged since your last read of this pane\nnew", collapsedLines: 2, hasNew: true } },
  { name: "an all-blank capture is returned untouched", seen: "a\nb", capture: "\n\n",
    out: { text: "\n\n", collapsedLines: 0, hasNew: true } },
  { name: "a single collapsed line reads as singular", seen: "only", capture: "only\nfresh",
    out: { text: "… 1 line unchanged since your last read of this pane\nfresh", collapsedLines: 1, hasNew: true } },
  { name: "a single idle line reads as singular", seen: "only", capture: "only",
    out: { text: "no new output in %175 since your last read (1 line unchanged)", collapsedLines: 1, hasNew: false } },
  // The second "done" is genuinely new output here, but it is indistinguishable
  // from the earlier "done". Pinning the behaviour: it joins the collapsed head,
  // and the marker count stays truthful about how many lines were dropped.
  { name: "new output that repeats an old line still counts it collapsed", seen: "done\nready", capture: "done\nready\ndone\nfresh",
    out: { text: "… 3 lines unchanged since your last read of this pane\nfresh", collapsedLines: 3, hasNew: true } }
];

test.each(cases)("collapseSeenPrefix: $name", ({ seen, capture, out }) => {
  expect(collapseSeenPrefix(capture, seen === null ? null : paneLineSet(seen), OPTS)).toEqual(out);
});

test("paneLineSet: drops blanks and trailing whitespace", () => {
  expect([...paneLineSet("a  \n\n b\n")]).toEqual(["a", " b"]);
});
