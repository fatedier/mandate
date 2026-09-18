import { useSearchParams } from "react-router";
import { useChangesSummary } from "./changes/useChangesSummary";

/** One line under the Summary: how much the feature has changed, as a link to
 *  the Changes tab. Absent when there is nothing to say — no branch, no data,
 *  or nothing changed — never an empty container. */
export function ChangesSummaryLine({ featureId, workItemStamp }: { featureId: string; workItemStamp: string }) {
  const { summary } = useChangesSummary(featureId, workItemStamp);
  const [searchParams, setSearchParams] = useSearchParams();
  if (!summary || summary.files === 0) return null;
  const openChanges = () => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "changes");
    setSearchParams(next, { replace: false });
  };
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <span className="label-micro shrink-0 text-chrome">Changes</span>
        <span aria-hidden className="h-px flex-1 bg-border-soft" />
      </div>
      {/* Literal spaces between the parts, not a flex `gap-*`: the line is
          read as one string (textContent, screen readers, copy) and a gap
          contributes no character. Not `flex` either — a flex container drops
          whitespace-only text nodes, so the spaces would vanish on screen.
          Inline text renders them and sits the mono and sans runs on one
          baseline. */}
      <button
        type="button"
        data-slot="changes-summary"
        onClick={openChanges}
        className="w-fit text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="font-mono text-diff-add-fg">+{summary.additions}</span>{" "}
        <span className="font-mono text-diff-del-fg">−{summary.deletions}</span>{" "}
        <span>· {summary.files} {summary.files === 1 ? "file" : "files"} · uncommitted</span>
      </button>
    </section>
  );
}
