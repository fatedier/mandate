import { useState, useMemo } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import type { Project } from "@/store/projects";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
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
  /** Click "💬 chat" on a card → open the overview chat drawer with a
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

  const showTopZone = buckets.pinned.length + buckets.attention.length > 0;
  const showMainZone = buckets.working.length + buckets.untracked.length > 0;

  const restore = async () => {
    setRestoring(true);
    try {
      await request("POST", api.projectReconcile(project.id), {});
    } finally {
      setRestoring(false);
    }
  };

  return (
    <section className="group/section flex flex-col gap-3">
      {/* A hairline under the project name is what makes the section read as a
          container. Without it the header was just another row at the same
          weight as the card titles below it, so where one project ended and the
          next began had to be inferred from whitespace alone. */}
      <header className="flex items-center justify-between gap-3 border-b border-border-soft pb-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2
              className="text-lg font-semibold truncate"
              title={project.workingDir}
            >
              {project.name}
            </h2>
            <span className="num shrink-0 text-2xs text-chrome" title="Features in this project">
              {project.features.length}
            </span>
            {tmuxStatus === "gone" && (
              <span
                className="flex items-center gap-1 text-xs text-amber"
                title={project.ownership === "adopted"
                  ? "Original tmux session is gone — adopt link broken"
                  : "tmux session was killed externally — click Restore to rebuild"}
              >
                <AlertTriangle className="h-3.5 w-3.5" />
                session missing
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {tmuxStatus === "gone" && project.ownership === "app" && (
            <Button variant="outline" size="sm" onClick={restore} disabled={restoring}>
              <RotateCw className={`h-3.5 w-3.5 ${restoring ? "animate-spin" : ""}`} />
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
        </div>
      </header>
      {project.features.length === 0 ? (
        <p className="text-sm text-muted-foreground">No features yet.</p>
      ) : (
        <>
          {showTopZone && (
            <div className="grid gap-2" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
              {buckets.pinned.map(({ feature, item }) => (
                item ? (
                  <FeatureCard
                    key={feature.id} variant="top"
                    projectSlug={project.tmuxSessionName} feature={feature} item={item}
                    onTogglePin={() => togglePin(feature.id)}
                    onAck={() => void patchNeedsUser(item.id, null)}
                    onPromote={() => startChatAboutItem({ id: item.id, title: item.title })}
                  />
                ) : (
                  <FeatureCard
                    key={feature.id} variant="untracked"
                    projectSlug={project.tmuxSessionName} feature={feature} item={null}
                  />
                )
              ))}
              {/* Flagged features stay INSIDE their project section — sorted
                  most urgent first by categorizeFeatures. They never teleport
                  to a global strip; the sidebar Home badge carries the
                  cross-project count. */}
              {buckets.attention.map(({ feature, item }) => (
                <FeatureCard
                  key={feature.id} variant="top"
                  projectSlug={project.tmuxSessionName} feature={feature} item={item}
                  onTogglePin={() => togglePin(feature.id)}
                  onAck={() => void patchNeedsUser(item.id, null)}
                  onPromote={() => startChatAboutItem({ id: item.id, title: item.title })}
                />
              ))}
            </div>
          )}
          {showMainZone && (
            <>
              {/* Divider between the attention zone and the steady-state zone.
                  It is a label, not a heading — it gets a rule so it reads as a
                  boundary rather than a third heading level competing with the
                  project name above it. */}
              <div className="flex items-center gap-2 pt-1">
                <span className="label-micro text-chrome">Running</span>
                <span className="num font-mono text-2xs text-chrome">{buckets.working.length}</span>
                <span aria-hidden className="h-px flex-1 bg-border-soft" />
              </div>
              {/* Frameless (see PassiveFeatureCard) but still a responsive grid.
                  Dropping the frame and dropping the multi-column layout are
                  separate decisions and only the first one was intended: these
                  items are compact and numerous, so a wide window should show
                  three across rather than one long column. */}
              <div
                className="grid gap-x-4 gap-y-1"
                style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(380px, 100%), 1fr))" }}
              >
                {buckets.working.map(({ feature, item }) => (
                  <FeatureCard
                    key={feature.id} variant="passive"
                    projectSlug={project.tmuxSessionName} feature={feature} item={item}
                    onTogglePin={() => togglePin(feature.id)}
                    onPromote={() => startChatAboutItem({ id: item.id, title: item.title })}
                  />
                ))}
                {buckets.untracked.map(({ feature }) => (
                  <FeatureCard
                    key={feature.id} variant="untracked"
                    projectSlug={project.tmuxSessionName} feature={feature} item={null}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

function resolveProjectTmuxStatus(project: Project): "alive" | "gone" {
  if (project.tmuxStatus) return project.tmuxStatus;
  if (project.tmuxAlive) return "alive";
  return "gone";
}
