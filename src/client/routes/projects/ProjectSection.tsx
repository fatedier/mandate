import { useState, useMemo } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import type { Project } from "@/store/projects";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { FeatureCard } from "@/routes/projects/FeatureCard";
import { NewFeatureDialog } from "@/routes/projects/NewFeatureDialog";
import { ProjectActionsMenu } from "@/routes/projects/ProjectActionsMenu";
import { useWorkItemsStore } from "@/store/work-items";
import { useAgentChatStore } from "@/store/agent-chat";
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
  const patchNeedsUser = useWorkItemsStore((s) => s.patchNeedsUser);
  const togglePin = useProjectsStore((s) => s.togglePin);
  const openDrawerWithWorkItemRef = useAgentChatStore((s) => s.openDrawerWithWorkItemRef);
  /** Click the Chat action on a row → open the manager chat drawer with a
   *  removable ref pill above the input. User types their question and
   *  sends; the message carries metadata.workItemRef so the chat renders
   *  a WorkItemMessageBlock for it. */
  const startChatAboutItem = (workItem: { id: string; title: string }) => {
    openDrawerWithWorkItemRef(
      { type: "manager" },
      { itemId: workItem.id, title: workItem.title, snapshotAt: new Date().toISOString() }
    );
  };

  const buckets = useMemo(() => {
    const map = new Map<string, WorkItemDto>();
    for (const item of items.values()) map.set(item.featureId, item);
    return categorizeFeatures(project.features, map);
  }, [project.features, items]);

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
        <NewFeatureDialog projectId={project.id} projectName={project.name} isGit={project.isGit} />
        <ProjectActionsMenu
          projectId={project.id}
          projectName={project.name}
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
              The sidebar Home badge carries the cross-project count (§3.2). */}
          {ordered.map(({ feature, item, variant }) => (
            <li key={feature.id} className="border-t border-border-soft first:border-t-0">
              {variant === "untracked" || !item ? (
                <FeatureCard variant="untracked" projectSlug={project.tmuxSessionName} feature={feature} item={null} />
              ) : (
                <FeatureCard
                  variant={variant}
                  projectSlug={project.tmuxSessionName} feature={feature} item={item}
                  onTogglePin={() => togglePin(feature.id)}
                  onAck={variant === "top" ? () => void patchNeedsUser(item.id, null) : undefined}
                  onPromote={() => startChatAboutItem({ id: item.id, title: item.title })}
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
