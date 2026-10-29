import { useState } from "react";
import { Fold } from "@/components/Fold";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { MemoryBriefDto, MemoryStatsResponse } from "@shared/api-contracts";
import { Section, SectionRow } from "@/components/Section";
import { MarkdownView } from "@/components/MarkdownView";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { browseHref } from "./memory-filters";

/**
 * The briefs: what every agent reads when a conversation starts — the user's,
 * then each project's. A row opens to the whole brief; none starts open.
 */
export function BriefsSection({
  briefs,
  stats
}: {
  briefs: MemoryBriefDto[];
  stats: MemoryStatsResponse;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Briefs" meta="what every agent reads when a conversation starts">
      {briefs.length === 0 ? (
        <SectionRow>
          <span className="text-2xs text-faint">No briefs yet. The dream writes them after its first run.</span>
        </SectionRow>
      ) : (
        briefs.map((brief) => {
          const key = brief.projectId ?? USER_KEY;
          return (
            <BriefRow
              key={key}
              brief={brief}
              count={memoryCount(brief, stats)}
              open={open === key}
              onToggle={() => setOpen((prev) => (prev === key ? null : key))}
            />
          );
        })
      )}
    </Section>
  );
}

const USER_KEY = "user";

function memoryCount(brief: MemoryBriefDto, stats: MemoryStatsResponse): number {
  if (brief.scope === "user") return stats.byScope.user;
  return stats.byProject.find((project) => project.projectId === brief.projectId)?.count ?? 0;
}

function BriefRow({
  brief,
  count,
  open,
  onToggle
}: {
  brief: MemoryBriefDto;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const title = brief.content.split("\n")[0];
  const name = brief.scope === "user" ? "You" : brief.projectName ?? brief.projectId ?? "project";
  return (
    <div data-slot="brief" className="border-t border-border-soft first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-13 w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-sel @max-[34rem]:flex-wrap @max-[34rem]:gap-y-0.5"
      >
        <span className="w-[76px] shrink-0 pt-px text-xs font-semibold @max-[34rem]:w-auto @max-[34rem]:basis-full">{name}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Open, the body starts with this line: it is shown once. */}
          {!open && <span className="truncate text-xs leading-normal text-foreground">{title}</span>}
          <span className="text-2xs text-chrome">
            {/* The name beside it says whose brief it is ("You", a project's
                name); a "your memories" or "project" here said it again. */}
            {count} {count === 1 ? "memory" : "memories"} · built {formatRelativeTime(brief.builtAt)}
            {brief.stale && <span className="text-amber"> · changes waiting for the next dream</span>}
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className={cn("mt-0.5 size-3.5 shrink-0 text-chrome transition-transform", open && "rotate-90")}
        />
      </button>
      <Fold open={open} className="px-3.5 pb-3.5 @min-[34rem]:pl-[102px]">
          <div data-slot="brief-body" className="rounded-sm border border-border-soft bg-background px-3 py-2.5 text-xs">
            {/* The whole brief, as agents read it: its first line too. */}
            <MarkdownView text={brief.content} small />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 pt-2 text-2xs text-chrome">
            <span className="num">{brief.tokens.toLocaleString()} of {brief.tokenLimit.toLocaleString()} tokens</span>
            <span aria-hidden>·</span>
            <Link
              to={brief.scope === "user" ? browseHref({ scope: "user" }) : browseHref({ projectId: brief.projectId ?? "" })}
              className="hit relative font-medium underline underline-offset-[3px] hover:text-foreground"
            >
              See its {count} {count === 1 ? "memory" : "memories"}
            </Link>
          </div>
      </Fold>
    </div>
  );
}
