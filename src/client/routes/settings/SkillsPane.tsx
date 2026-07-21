import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { SettingsSection } from "./SettingsSection";
import type { SkillsResponse, SkillSummaryDto } from "@shared/api-contracts";

/** Skills pane: read-only registry listing with an inline rescan — no save unit. */
export function SkillsPane() {
  const [skills, setSkills] = useState<SkillSummaryDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (force = false) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    try {
      const url = force ? api.skillsRefresh : api.skills;
      const res = await fetch(url, {
        method: force ? "POST" : "GET",
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = (await res.json()) as SkillsResponse;
      setSkills(payload.skills);
      setError("");
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  if (error) {
    return (
      <div className="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-3 text-sm text-destructive">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          Retry
        </Button>
      </div>
    );
  }

  if (skills === null) return <SkillsSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      <SettingsSection
        title="Installed skills"
        description={
          skills.length === 0
            ? "None loaded."
            : `${skills.length} skill${skills.length === 1 ? "" : "s"} available to agents.`
        }
        rows
        headerSlot={
          <Button variant="outline" size="xs" onClick={() => void load(true)} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            <span className="ml-1.5">Rescan</span>
          </Button>
        }
      >
        {skills.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            No skills loaded.
          </div>
        ) : (
          skills.map((skill) => <SkillRow key={skill.name} skill={skill} />)
        )}
      </SettingsSection>

      <p className="px-1 text-2xs leading-relaxed text-chrome">
        Drop your own in{" "}
        <code className="font-mono text-muted-foreground">~/.mandate/skills/&lt;name&gt;/SKILL.md</code>.
        The registry rescans every 5 minutes. A user skill sharing a built-in&apos;s name overrides
        it.
      </p>
    </div>
  );
}

/**
 * The source path used to sit under every row in mono. It is near-identical
 * down the whole list and three times the length of the name, so it read as
 * the primary content while being the least distinguishing field. It's the
 * row's tooltip now.
 */
function SkillRow({ skill }: { skill: SkillSummaryDto }) {
  return (
    <div className="px-4 py-2.5" title={skill.sourcePath}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-medium">{skill.name}</span>
        <SourceBadge source={skill.source} />
        <div className="flex-1" />
        <span className="shrink-0 text-2xs text-chrome">{skill.scope.join(", ")}</span>
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {skill.description}
      </p>
    </div>
  );
}

function SourceBadge({ source }: { source: SkillSummaryDto["source"] }) {
  // Built-in is the default and by far the most common — it gets no colour, so
  // the badges that do stand for something you did.
  const cls = {
    builtin: "border-border-soft text-chrome",
    user: "border-phase-done/40 text-phase-done bg-phase-done/5",
    extra: "border-status-review/40 text-status-review bg-status-review/5"
  }[source];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-xs border px-1.5 text-2xs font-medium",
        cls
      )}
    >
      {source}
    </span>
  );
}

function SkillsSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border-soft bg-card">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-7 w-20" />
      </div>
      <div className="divide-y divide-border-soft border-t border-border-soft">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 px-4 py-3">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-full max-w-md" />
          </div>
        ))}
      </div>
    </div>
  );
}
