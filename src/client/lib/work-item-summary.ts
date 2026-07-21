import type { WorkItemDto, WorkItemSummaryAuthor } from "@shared/api/work-items";
import { formatRelativeTime } from "@/lib/format";

/** Reduce one line to the form used for duplicate comparison ONLY.
 *
 *  The rules are the explicit markdown strippers the Projects card already
 *  applies when it flattens a summary for preview — a leading list / heading /
 *  quote marker, backticks, and bold fences — plus a trim. Nothing else: no
 *  case folding, no punctuation removal, no whitespace collapsing, no
 *  stemming. Anything looser starts deleting lines that merely resemble the
 *  phase detail while carrying information it does not. */
function canonicalizeForComparison(line: string): string {
  return line
    .replace(/^\s*[#*\->]+\s*/, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .trim();
}

/** Drop summary lines that are exactly the phase detail, keeping every other
 *  line intact.
 *
 *  The feature pane shows phaseDetail in its header and the summary right
 *  below it, and the Projects card shows them one under the other — when an
 *  agent writes the same sentence into both, the user reads it twice. This
 *  removes only that exact repetition, line by line, so a summary that
 *  mentions the current step *and* says something more keeps the rest.
 *
 *  Returns null when nothing survives: the surviving text was entirely a
 *  restatement, which is the same thing as having no summary to add. */
export function dedupeSummaryAgainstPhaseDetail(
  summary: string | null | undefined,
  phaseDetail: string | null | undefined
): string | null {
  const text = summary ?? null;
  if (!text) return null;
  const target = canonicalizeForComparison(phaseDetail ?? "");
  if (!target) return text;

  const kept = text
    .split("\n")
    .filter((line) => {
      const canonical = canonicalizeForComparison(line);
      // Blank lines carry no claim of their own; keep them so the surviving
      // markdown keeps its paragraph structure, unless everything else went.
      if (canonical === "") return true;
      return canonical !== target;
    })
    .join("\n")
    .trim();

  return kept === "" ? null : kept;
}

const SUMMARY_AUTHOR_LABEL: Record<WorkItemSummaryAuthor, string> = {
  worker: "worker",
  manager: "manager"
};

export function formatSummaryAuthor(author: WorkItemSummaryAuthor | null | undefined): string | null {
  return author ? SUMMARY_AUTHOR_LABEL[author] ?? null : null;
}

/** The "who wrote this, when" line under the Summary rule.
 *
 *  Each fragment appears only when its field has a value. A missing author or
 *  a missing timestamp is omitted outright — never rendered as "unknown", and
 *  never substituted with lastActivityAt, which any patch to the work item
 *  refreshes and which therefore says nothing about when this text was
 *  written. When both are missing the caller gets null and drops the row. */
export function summaryMetaText(
  item: Pick<WorkItemDto, "summaryUpdatedAt" | "summaryUpdatedBy">,
  now?: number
): string | null {
  const author = formatSummaryAuthor(item.summaryUpdatedBy);
  const written = item.summaryUpdatedAt
    ? formatRelativeTime(item.summaryUpdatedAt, now ?? Date.now())
    : "";
  const parts: string[] = [];
  if (author) parts.push(author);
  if (written) parts.push(`written ${written}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
