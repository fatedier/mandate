import { expect, test } from "bun:test";
import {
  dedupeSummaryAgainstPhaseDetail,
  formatSummaryAuthor,
  summaryMetaText
} from "../../src/client/lib/work-item-summary.js";

// ── what gets removed ────────────────────────────────────────────────────

test("a summary that is only the phase detail leaves nothing to show", () => {
  expect(dedupeSummaryAgainstPhaseDetail("running the suite", "running the suite")).toBeNull();
});

test("the same sentence as a bullet still counts as the same sentence", () => {
  expect(dedupeSummaryAgainstPhaseDetail("- running the suite", "running the suite")).toBeNull();
  expect(dedupeSummaryAgainstPhaseDetail("* running the suite", "running the suite")).toBeNull();
  expect(dedupeSummaryAgainstPhaseDetail("> running the suite", "running the suite")).toBeNull();
});

test("surrounding whitespace is not a difference", () => {
  expect(dedupeSummaryAgainstPhaseDetail("  running the suite\n", " running the suite ")).toBeNull();
});

test("the repeated line goes and the rest of the summary stays", () => {
  const summary = "- Chose the additive migration.\n- running the suite\n- Ships behind no flag.";
  expect(dedupeSummaryAgainstPhaseDetail(summary, "running the suite"))
    .toBe("- Chose the additive migration.\n- Ships behind no flag.");
});

test("markdown emphasis around the repeat does not hide it", () => {
  expect(dedupeSummaryAgainstPhaseDetail("- **running the suite**", "running the suite")).toBeNull();
  expect(dedupeSummaryAgainstPhaseDetail("- `running the suite`", "running the suite")).toBeNull();
});

// ── what must survive ────────────────────────────────────────────────────

test("a near-match with extra information is kept in full", () => {
  const cases: Array<[string, string]> = [
    ["running the suite, 3 failures left", "running the suite"],
    ["running the suite again", "running the suite"],
    ["re-running the suite", "running the suite"],
    ["running the suites", "running the suite"],
    ["running the suite.", "running the suite"],
    ["Running the suite", "running the suite"],
    ["running  the  suite", "running the suite"]
  ];
  for (const [summary, phaseDetail] of cases) {
    expect(dedupeSummaryAgainstPhaseDetail(summary, phaseDetail)).toBe(summary);
  }
});

test("only the exact line goes — other lines are never collateral", () => {
  const summary = "running the suite\nrunning the suite twice\nrunning";
  expect(dedupeSummaryAgainstPhaseDetail(summary, "running the suite"))
    .toBe("running the suite twice\nrunning");
});

test("with no phase detail the summary passes through untouched", () => {
  expect(dedupeSummaryAgainstPhaseDetail("Anything at all", null)).toBe("Anything at all");
  expect(dedupeSummaryAgainstPhaseDetail("Anything at all", "")).toBe("Anything at all");
  expect(dedupeSummaryAgainstPhaseDetail("Anything at all", "   ")).toBe("Anything at all");
});

test("an empty summary stays empty rather than becoming a string", () => {
  expect(dedupeSummaryAgainstPhaseDetail(null, "detail")).toBeNull();
  expect(dedupeSummaryAgainstPhaseDetail("", "detail")).toBeNull();
});

test("paragraph structure survives when only one line is dropped", () => {
  // Blank lines are kept: they carry no claim of their own, and markdown
  // renders the extra one identically. Only the repeated line goes.
  const summary = "Conclusion.\n\nrunning the suite\n\nNext up: review.";
  expect(dedupeSummaryAgainstPhaseDetail(summary, "running the suite"))
    .toBe("Conclusion.\n\n\nNext up: review.");
});

// ── metadata formatting ──────────────────────────────────────────────────

test("each writer gets its own label", () => {
  expect(formatSummaryAuthor("worker")).toBe("worker");
  expect(formatSummaryAuthor("manager")).toBe("manager");
  expect(formatSummaryAuthor(null)).toBeNull();
});

test("both facts present reads as author then write time", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  expect(summaryMetaText({
    summaryUpdatedBy: "worker",
    summaryUpdatedAt: "2026-08-03T11:54:00.000Z"
  }, now)).toBe("worker · written 6m ago");
});

test("a missing fact is omitted, never rendered as unknown", () => {
  const now = Date.parse("2026-08-03T12:00:00.000Z");
  expect(summaryMetaText({
    summaryUpdatedBy: null,
    summaryUpdatedAt: "2026-08-03T11:54:00.000Z"
  }, now)).toBe("written 6m ago");
  expect(summaryMetaText({
    summaryUpdatedBy: "manager",
    summaryUpdatedAt: null
  }, now)).toBe("manager");
});

test("neither fact known means there is no metadata line at all", () => {
  expect(summaryMetaText({ summaryUpdatedBy: null, summaryUpdatedAt: null })).toBeNull();
});

test("an unparseable timestamp is dropped rather than printed raw", () => {
  expect(summaryMetaText({ summaryUpdatedBy: null, summaryUpdatedAt: "not a date" })).toBeNull();
  expect(summaryMetaText({ summaryUpdatedBy: "manager", summaryUpdatedAt: "not a date" }))
    .toBe("manager");
});
