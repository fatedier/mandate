import { useState, useMemo } from "react";
import { useNavigate } from "react-router";
import { AlertTriangle, RotateCw } from "lucide-react";
import type { Project } from "@/store/projects";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { FeatureCard } from "@/routes/projects/FeatureCard";
import { ProjectActionsMenu } from "@/routes/projects/ProjectActionsMenu";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlansStore } from "@/store/feature-plans";
import { useWakeActivityStore } from "@/store/wake-activity";
import { isAsking } from "@shared/feature-state";
import { featureHref, threadHref } from "@/lib/feature-href";
import { useProjectsStore } from "@/store/projects";
import type { WorkItemDto } from "@shared/api/work-items";
import { categorizeFeatures } from "./feature-card-data";

interface ProjectSectionProps {
  project: Project;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveToTop: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

export function ProjectSection({
  project,
  canMoveUp,
  canMoveDown,
  onMoveToTop,
  onMoveUp,
  onMoveDown
}: ProjectSectionProps) {
  const request = useApi();
  const [restoring, setRestoring] = useState(false);
  const tmuxStatus = resolveProjectTmuxStatus(project);

  const items = useWorkItemsStore((s) => s.items);
  const plans = useFeaturePlansStore((s) => s.plans);
  const activeByFeatureId = useWakeActivityStore((s) => s.activeByFeatureId);
  const acknowledge = useWorkItemsStore((s) => s.acknowledge);
  const togglePin = useProjectsStore((s) => s.togglePin);
  const navigate = useNavigate();
  /** A row's Open: the thread that owns the worker, with its tab open; a
   *  worker without one, its own page. */
  const openWorker = (feature: Project["features"][number]) => {
    navigate(feature.ownerThreadId
      ? `${threadHref(feature.ownerThreadId)}?worker=${encodeURIComponent(feature.id)}`
      : featureHref(project.tmuxSessionName, feature.tmuxWindowName));
  };

  const buckets = useMemo(() => {
    const map = new Map<string, WorkItemDto>();
    for (const item of items.values()) map.set(item.featureId, item);
    const asking = new Set(project.features
      .filter((f) => isAsking(plans.get(f.id)) && !activeByFeatureId.has(f.id))
      .map((f) => f.id));
    return categorizeFeatures(project.features, map, asking);
  }, [project.features, items, plans, activeByFeatureId]);

  const restore = async () => {
    setRestoring(true);
    try {
      await request("POST", api.projectReconcile(project.id), {});
    } finally {
      setRestoring(false);
    }
  };

  const ordered = [
    ...buckets.pinned.map(({ feature, item }) => ({ feature, item, variant: item ? ("top" as const) : ("untracked" as const) })),
    ...buckets.attention.map(({ feature, item }) => ({ feature, item, variant: "top" as const })),
    ...buckets.working.map(({ feature, item }) => ({ feature, item, variant: "passive" as const })),
    ...buckets.untracked.map(({ feature }) => ({ feature, item: null, variant: "untracked" as const }))
  ];
  const empty = project.features.length === 0;

  return (
    <section className="flex flex-col gap-1.5">
      {/* One 32px line: the name is the only heavy element; everything after it
          is furniture. An empty project keeps only this line — no container. */}
      <header data-slot="project-header" className="flex h-8 items-center gap-2">
        <h2 className="min-w-0 truncate text-xs font-semibold text-foreground" title={project.workingDir}>
          {project.name}
        </h2>
        {!empty && (
          <span data-slot="feature-count" className="num shrink-0 text-2xs text-faint" title="Features in this project">
            {project.features.length}
          </span>
        )}
        {empty && (
          <span data-slot="project-empty" className="shrink-0 text-2xs text-faint">No features yet</span>
        )}
        {tmuxStatus === "gone" && (
          <span
            className="flex shrink-0 items-center gap-1 text-2xs text-amber"
            title={project.ownership === "adopted"
              ? "Original tmux session is gone — adopt link broken"
              : "tmux session was killed externally — click Restore to rebuild"}
          >
            <AlertTriangle className="size-3.5" />
            {/* The label text yields below md so the 32px line still fits a
                360px phone with Restore + New feature + ⋯ beside it; the icon
                and the wrapper's title keep the warning visible there. */}
            <span className="hidden md:inline">session missing</span>
          </span>
        )}
        <span className="flex-1" />
        {tmuxStatus === "gone" && project.ownership === "app" && (
          <Button variant="ghost" size="xs" onClick={restore} disabled={restoring} className="text-chrome hover:text-foreground">
            <RotateCw className={cn("size-3.5", restoring && "animate-spin")} />
            {restoring ? "Restoring…" : "Restore"}
          </Button>
        )}
        <ProjectActionsMenu
          projectId={project.id}
          projectName={project.name}
          workingDir={project.workingDir}
          inProjectWorkers={project.features.filter((f) => f.mode === "shared-cwd" && !f.archivedAt).map((f) => f.name)}
          hasTmuxSession={tmuxStatus !== "gone"}
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onMoveToTop={onMoveToTop}
          onMoveUp={onMoveUp}
          onMoveDown={onMoveDown}
        />
      </header>
      {!empty && (
        <ul data-slot="feature-list" className="overflow-hidden rounded-lg border border-border-soft bg-panel">
          {/* Flagged features stay INSIDE their project section — most urgent
              first by categorizeFeatures; they never teleport to a global strip.
              The sidebar Home badge carries the cross-project count. */}
          {ordered.map(({ feature, item, variant }) => (
            <li key={feature.id} className="border-t border-border-soft first:border-t-0">
              {variant === "untracked" || !item ? (
                <FeatureCard variant="untracked" projectSlug={project.tmuxSessionName} feature={feature} item={null} />
              ) : (
                <FeatureCard
                  variant={variant}
                  projectSlug={project.tmuxSessionName} feature={feature} item={item}
                  onTogglePin={() => togglePin(feature.id)}
                  onAck={variant === "top" ? () => void acknowledge(item.id) : undefined}
                  onPromote={() => openWorker(feature)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function resolveProjectTmuxStatus(project: Project): "alive" | "gone" {
  if (project.tmuxStatus) return project.tmuxStatus;
  if (project.tmuxAlive) return "alive";
  return "gone";
}
