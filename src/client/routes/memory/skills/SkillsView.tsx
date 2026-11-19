import { useState } from "react";
import { useSearchParams } from "react-router";
import type { LearnedSkillSummaryDto } from "@shared/api-contracts";
import { SimpleSelect } from "@/components/ui/select";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { formatRelativeTime } from "@/lib/format";
import { withParam } from "@/lib/url-params";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { SkillDetail } from "./SkillDetail";
import { skillAuthor, skillWhere } from "./skill-copy";
import { useLearnedSkills, type SkillListFilters } from "./use-learned-skills";

/**
 * Memory → Skills: the skills agents learned, read only. A skill opens in
 * place (`skill` in the address, with `revision` for one of its History's
 * revisions, as a notice links to it); the way back is the address's. To
 * change one, the owner asks an agent.
 */
export function SkillsView({ refreshKey = 0 }: { refreshKey?: number }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const open = searchParams.get("skill");
  const revisionParam = Number(searchParams.get("revision"));
  const revision = Number.isInteger(revisionParam) && revisionParam > 0 ? revisionParam : null;
  const [filters, setFilters] = useState<SkillListFilters>({ scope: "all", status: "available" });

  if (open) {
    return (
      <SkillDetail
        key={open}
        id={open}
        revision={revision}
        refreshKey={refreshKey}
        onRevision={(next) => setSearchParams((prev) => withParam(prev, "revision", next === null ? null : String(next)), { replace: true })}
        onBack={() => setSearchParams((prev) => withParam(withParam(prev, "skill", null), "revision", null))}
      />
    );
  }
  return (
    <SkillList
      refreshKey={refreshKey}
      filters={filters}
      setFilters={setFilters}
      onOpen={(id) => setSearchParams((prev) => withParam(withParam(prev, "skill", id), "revision", null))}
    />
  );
}

function SkillList({ refreshKey, filters, setFilters, onOpen }: { refreshKey: number; filters: SkillListFilters; setFilters: (next: SkillListFilters) => void; onOpen: (id: string) => void }) {
  const { data, error, reload } = useLearnedSkills(filters, refreshKey);
  const agentLabel = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const scopes = [
    { value: "all", label: "All scopes" },
    { value: "global", label: "Global" },
    ...(data?.projects ?? []).map((p) => ({ value: `project:${p.id}`, label: p.name }))
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 pointer-coarse:gap-y-4">
        <SimpleSelect
          aria-label="Scope"
          className="w-40"
          value={filters.scope}
          // The chosen project stays listed while its answer comes.
          options={scopes.some((s) => s.value === filters.scope) ? scopes : [...scopes, { value: filters.scope, label: filters.scope.slice("project:".length) }]}
          onValueChange={(scope) => setFilters({ ...filters, scope })}
        />
        <SimpleSelect
          aria-label="Status"
          className="w-32"
          value={filters.status}
          options={[{ value: "available", label: "Available" }, { value: "archived", label: "Archived" }]}
          onValueChange={(status) => setFilters({ ...filters, status: status as SkillListFilters["status"] })}
        />
      </div>
      <p className="text-xs leading-relaxed text-chrome">
        To change a skill, ask your agent: undo a change, go back to a revision, archive, restore or move it.
      </p>
      {error ? (
        <InlineError detail={error} onRetry={reload}>Couldn't load skills.</InlineError>
      ) : !data ? (
        <LoadingLine />
      ) : data.skills.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No learned skills yet. They're written from finished work when an agent asks for a review; you'll be told when one is written.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
          {data.skills.map((skill) => <SkillRow key={skill.id} skill={skill} agentLabel={agentLabel} onOpen={() => onOpen(skill.id)} />)}
        </ul>
      )}
    </div>
  );
}

function SkillRow({ skill, agentLabel, onOpen }: { skill: LearnedSkillSummaryDto; agentLabel: string; onOpen: () => void }) {
  return (
    <li data-slot="skill-row" className="min-w-0">
      <button type="button" onClick={onOpen} className="flex w-full min-w-0 flex-col gap-1 px-3 py-2.5 text-left hover:bg-sel focus-visible:-outline-offset-2 pointer-coarse:py-3.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span data-slot="skill-name" className="min-w-0 truncate font-mono text-xs font-medium text-foreground">{skill.name}</span>
          {/* A long project name is cut at half the row, never past it, and
              leaves the skill's own name the rest. */}
          <span data-slot="skill-where" className="min-w-0 max-w-[50%] truncate rounded-sm bg-sel px-1.5 text-2xs text-chrome">{skillWhere(skill)}</span>
        </span>
        <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{skill.description}</span>
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-chrome">
          <span>Uses (30 days) {skill.uses30}</span>
          <span>{skill.lastUsedAt ? `Last used ${formatRelativeTime(skill.lastUsedAt)}` : "Never used"}</span>
          <span>Changed {formatRelativeTime(skill.lastChange.at)} · {skillAuthor(skill.lastChange, agentLabel)}</span>
        </span>
      </button>
    </li>
  );
}
