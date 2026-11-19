import type { LearnedSkillVersionDto } from "@shared/api-contracts";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { formatRelativeTime } from "@/lib/format";
import { parseUnifiedDiff } from "@/lib/diff-parse";
import { cn } from "@/lib/utils";
import { DiffHunkView } from "@/routes/window/changes/DiffHunkView";
import { skillAuthor } from "./skill-copy";
import { useSkillRevision } from "./use-learned-skills";

/** A skill's revisions, newest first: number, who, when and why; the open
 *  one shows its change against the revision before, as a diff. */
export function SkillHistory({ skillId, versions, open, onOpen, agentLabel, refreshKey }: {
  skillId: string; versions: LearnedSkillVersionDto[]; open: number | null; onOpen: (revision: number) => void; agentLabel: string;
  /** The page's Refresh: the open change is read again with it. */
  refreshKey: number;
}) {
  return (
    <ol className="flex min-w-0 flex-col divide-y divide-border rounded-md border border-border">
      {versions.map((v) => {
        const isOpen = v.revision === open;
        return (
          <li key={v.revision} data-slot="skill-revision" data-open={isOpen ? "true" : undefined} className="min-w-0">
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => onOpen(v.revision)}
              className={cn("flex w-full min-w-0 flex-col gap-0.5 px-3 py-2 text-left hover:bg-sel focus-visible:-outline-offset-2 pointer-coarse:py-3", isOpen && "bg-sel")}
            >
              <span data-slot="revision-head" className="text-xs text-foreground">
                Revision {v.revision} · {skillAuthor(v, agentLabel)} · {formatRelativeTime(v.at)}
              </span>
              {v.reason && <span className="text-xs leading-relaxed text-muted-foreground">{v.reason}</span>}
            </button>
            {isOpen && <RevisionChange skillId={skillId} revision={v.revision} refreshKey={refreshKey} />}
          </li>
        );
      })}
    </ol>
  );
}

function RevisionChange({ skillId, revision, refreshKey }: { skillId: string; revision: number; refreshKey: number }) {
  const { data, error, reload } = useSkillRevision(skillId, revision, refreshKey);
  if (error) return <div className="px-3 pb-3"><InlineError detail={error} onRetry={reload}>Couldn't load the change.</InlineError></div>;
  if (!data) return <LoadingLine className="px-3 pb-3" />;
  return (
    // min-w-0: a long line scrolls inside the diff, never the page.
    <div data-slot="revision-diff" className="min-w-0 border-t border-border">
      {data.patch !== null ? (
        <DiffHunkView hunks={parseUnifiedDiff(data.patch)} unified />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-5">{data.body}</pre>
      )}
    </div>
  );
}
