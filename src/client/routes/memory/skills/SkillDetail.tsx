import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { LearnedSkillDto, LearnedSkillVersionDto } from "@shared/api-contracts";
import { Button } from "@/components/ui/button";
import { MarkdownView } from "@/components/MarkdownView";
import { PillTabs } from "@/components/PillTabs";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { formatRelativeTime } from "@/lib/format";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { SkillHistory } from "./SkillHistory";
import { skillAuthor, skillWhere } from "./skill-copy";
import { useLearnedSkill } from "./use-learned-skills";

type Tab = "skill" | "history";

/** One skill: its facts, its text (Skill) and its revisions (History). The
 *  address says which: a revision named in it is History open at that
 *  revision, none is Skill — so a notice's link, a reload and Back all land
 *  where the owner was. */
export function SkillDetail({ id, revision, refreshKey, onRevision, onBack }: {
  id: string; revision: number | null; refreshKey: number; onRevision: (revision: number | null) => void; onBack: () => void;
}) {
  // A link to a revision newer than the history read (a notice of a change
  // made since) reads the skill again, once for that revision.
  const asked = useRef<number | null>(null);
  const [again, setAgain] = useState(0);
  const { data, error, reload } = useLearnedSkill(id, refreshKey + again);
  useEffect(() => {
    if (revision === null || !data || data.versions.some((v) => v.revision === revision) || revision <= data.skill.revision || asked.current === revision) return;
    asked.current = revision;
    const timer = window.setTimeout(() => setAgain((n) => n + 1), 0);
    return () => window.clearTimeout(timer);
  }, [revision, data]);
  const tab: Tab = revision === null ? "skill" : "history";
  const setTab = (next: Tab) => onRevision(next === "skill" ? null : data?.versions[0]?.revision ?? null);
  const agentLabel = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div>
        <Button variant="ghost" size="xs" onClick={onBack} className="-ml-2 text-chrome">
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden />
          Skills
        </Button>
      </div>
      {error ? (
        <InlineError detail={error} onRetry={reload}>Couldn't load the skill.</InlineError>
      ) : !data ? (
        <LoadingLine />
      ) : (
        <Loaded skill={data.skill} versions={data.versions} tab={tab} setTab={setTab} revision={revision} onRevision={onRevision} agentLabel={agentLabel} refreshKey={refreshKey} />
      )}
    </div>
  );
}

function Loaded({ skill, versions, tab, setTab, revision, onRevision, agentLabel, refreshKey }: {
  skill: LearnedSkillDto; versions: LearnedSkillVersionDto[]; tab: Tab; setTab: (tab: Tab) => void;
  revision: number | null; onRevision: (revision: number) => void; agentLabel: string; refreshKey: number;
}) {
  const tabs = useMemo(() => [{ id: "skill" as const, label: "Skill" }, { id: "history" as const, label: `History · ${versions.length}` }], [versions.length]);
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-baseline gap-2">
        <h2 className="min-w-0 break-all font-mono text-sm font-semibold text-foreground">{skill.name}</h2>
        <span className="rounded-sm bg-sel px-1.5 text-2xs text-chrome">{skillWhere(skill)}</span>
        {skill.status === "archived" && <span className="rounded-sm bg-sel px-1.5 text-2xs text-chrome">Archived · {skill.archivedReason ?? ""}</span>}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{skill.description}</p>
      <div data-slot="skill-facts" className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-chrome">
        <span>Scope {skillWhere(skill)}</span>
        <span>Revision {skill.revision}</span>
        <span>Created by {skillAuthor(skill.createdBy, agentLabel)}</span>
        <span>Uses (30 days) {skill.uses30}</span>
        <span>{skill.lastUsedAt ? `Last used ${formatRelativeTime(skill.lastUsedAt)}` : "Never used"}</span>
      </div>
      <div data-slot="skill-tabs">
        <PillTabs items={tabs} value={tab} onChange={setTab} aria-label="Skill views" />
      </div>
      {tab === "skill" ? (
        <div className="min-w-0">
          <MarkdownView text={skill.body} />
        </div>
      ) : (
        <SkillHistory skillId={skill.id} versions={versions} open={revision ?? versions[0]?.revision ?? null} onOpen={onRevision} agentLabel={agentLabel} refreshKey={refreshKey} />
      )}
    </>
  );
}
