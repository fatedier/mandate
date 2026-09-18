import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { Loader2, Plus } from "lucide-react";
import { useSnapshotStore } from "@/store/snapshot";
import { useProjectsStore, findFeatureBySlug } from "@/store/projects";
import type { Feature, Project } from "@/store/projects";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { parseTmuxLayout } from "@/lib/tmux";
import { useUiPageSummary } from "@/lib/ui-context";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/Section";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import { PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useIsMobile } from "@/hooks/useIsMobile";

import { FeatureTitle } from "./WindowPageHeader";
import { FeatureActionsMenu } from "./FeatureActionsMenu";
import { useWorkItemsStore } from "@/store/work-items";
import { FeatureWorkItemDashboard } from "./FeatureWorkItemDashboard";
import { ActiveWorkerCanvas } from "./WorkerCanvasCache";
import { FeatureArtifactsTab } from "./FeatureArtifactsTab";
import { ChangesTab } from "./changes/ChangesTab";
import { ChangesSummaryLine } from "./ChangesSummaryLine";
import { shouldIgnoreGlobalEscape } from "@/lib/keyboard-targets";
import { TmuxLayoutBoard } from "@/routes/window/TmuxLayoutBoard";
import { PaneDetail } from "@/routes/window/PaneDetail";
import { toast } from "sonner";

export function WindowPage() {
  const params = useParams<{ projectSlug?: string; featureSlug?: string }>();
  const navigate = useNavigate();
  const project = useProjectsStore((s) => params.projectSlug ? s.bySlug[params.projectSlug] : undefined);
  const feature = useMemo(
    () => findFeatureBySlug(project, params.featureSlug) ?? null,
    [project, params.featureSlug]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (shouldIgnoreGlobalEscape(event)) return;
      navigate("/projects");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [navigate]);

  if (!project || !feature) {
    return (
      <div className="flex flex-col gap-1 w-full mx-auto max-w-[1280px] px-4 pt-1 pb-6 md:px-7 group-data-[pane-mode=worker]/workspace:max-w-none">
        <h1 className="text-sm font-semibold">Feature not found</h1>
        <p className="text-sm text-faint">This project or feature has been archived.</p>
      </div>
    );
  }

  return <WindowBody key={feature.id} project={project} feature={feature} onClose={() => navigate("/projects")} />;
}

interface WindowBodyProps {
  project: Project;
  feature: Feature;
  onClose: () => void;
}

function WindowBody({ project, feature, onClose }: WindowBodyProps) {
  const windowData = useSnapshotStore((s) => (
    selectSnapshotWindow(s.snapshot, project.tmuxSessionName, feature.tmuxWindowName)
  ));
  const togglePin = useProjectsStore((s) => s.togglePin);
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();

  const aggregate = windowData?.aggregate;
  const paneCount = windowData?.panes?.length ?? 0;
  const workItem = useWorkItemsStore((s) => {
    if (!feature?.id) return null;
    for (const it of s.items.values()) {
      if (it.featureId === feature.id) return it;
    }
    return null;
  });
  useUiPageSummary("feature-window", () => ({
    page: "feature-window",
    project: {
      id: project.id,
      name: project.name,
      slug: project.tmuxSessionName,
      workingDir: project.workingDir
    },
    feature: {
      id: feature.id,
      name: feature.name,
      slug: feature.tmuxWindowName,
      mode: feature.mode,
      branch: feature.branch,
      worktreePath: feature.worktreePath
    },
    aggregate: aggregate ?? null,
    panes: (windowData?.panes ?? []).map((pane) => ({
      paneId: pane.paneId,
      active: pane.paneActive,
      currentCommand: pane.currentCommand,
      currentPath: pane.currentPath,
      width: pane.paneWidth,
      height: pane.paneHeight
    }))
  }));

  // Live signal: motion means the window is actually working right now.
  const aggregateStatus = aggregate?.status;
  const windowActive = aggregateStatus === "working" || aggregateStatus === "running_service";
  const wakeActive = useFeatureWakeActive(feature.id);

  const tabParam = searchParams.get("tab");
  const activeTab: "overview" | "terminal" | "artifacts" | "changes" =
    tabParam === "terminal" ? "terminal"
    : tabParam === "artifacts" ? "artifacts"
    : tabParam === "changes" ? "changes"
    : "overview";

  const setActiveTab = (tab: "overview" | "terminal" | "artifacts" | "changes") => {
    const next = new URLSearchParams(searchParams);
    if (tab === "overview") next.delete("tab");
    else next.set("tab", tab);
    if (tab !== "changes") next.delete("file");
    setSearchParams(next, { replace: false });
  };

  if (windowData === undefined) {
    return (
      <div className="flex flex-col gap-4 w-full mx-auto max-w-[1280px] px-4 pt-1 pb-6 md:px-7 group-data-[pane-mode=worker]/workspace:max-w-none">
        <p className="text-sm text-faint">Loading…</p>
      </div>
    );
  }

  if (!windowData) {
    return (
      <MissingWindowState
        project={project}
        feature={feature}
        onClose={onClose}
      />
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col w-full mx-auto gap-4 px-4 pt-1 pb-6 md:px-7 group-data-[pane-mode=worker]/workspace:max-w-none",
        // Diffs are the one surface that earns the full viewport: side-by-side
        // columns starve inside the reading-width cap the other tabs keep.
        activeTab === "changes" ? "max-w-none" : "max-w-[1280px]",
        activeTab === "overview" && workItem?.canvasId && "pb-4 md:pb-4"
      )}
    >
      {/* Desktop: title and actions live in the left pane's 52px header.
          Mobile keeps an in-page row — its top bar is the breadcrumb. */}
      {isMobile ? (
        <div className="flex items-center gap-2 px-1">
          <FeatureTitle window={windowData} workItem={workItem} active={wakeActive || windowActive} />
          <FeatureActionsMenu
            featureId={feature.id}
            featureName={feature.name}
            featureMode={feature.mode}
            branch={feature.branch}
            hasWorktree={!!feature.worktreePath}
            window={windowData}
            pinned={!!feature.pinnedAt}
            onTogglePin={() => void togglePin(feature.id)}
            onClose={onClose}
          />
        </div>
      ) : (
        <>
          <PaneHeaderTitle>
            <FeatureTitle window={windowData} workItem={workItem} active={wakeActive || windowActive} />
          </PaneHeaderTitle>
          <PaneHeaderActions>
            <FeatureActionsMenu
              featureId={feature.id}
              featureName={feature.name}
              featureMode={feature.mode}
              branch={feature.branch}
              hasWorktree={!!feature.worktreePath}
              window={windowData}
              pinned={!!feature.pinnedAt}
              onTogglePin={() => void togglePin(feature.id)}
              onClose={onClose}
            />
          </PaneHeaderActions>
        </>
      )}

      {/* Tab bar */}
      <div className="flex h-9 items-center gap-0.5" role="tablist">
        <TabButton active={activeTab === "overview"} onClick={() => setActiveTab("overview")}>
          Overview
        </TabButton>
        <TabButton active={activeTab === "artifacts"} onClick={() => setActiveTab("artifacts")}>
          Canvases
        </TabButton>
        {feature.branch ? (
          <TabButton active={activeTab === "changes"} onClick={() => setActiveTab("changes")}>
            Changes
          </TabButton>
        ) : null}
        <TabButton active={activeTab === "terminal"} onClick={() => setActiveTab("terminal")}>
          Terminal
          {windowActive && (
            <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-live animate-live align-middle" />
          )}
        </TabButton>
      </div>

      {/* Tab body */}
      {activeTab === "overview" && feature.id && (
        <>
          <FeatureWorkItemDashboard featureId={feature.id} />
          {feature.branch && (
            <ChangesSummaryLine
              featureId={feature.id}
              workItemStamp={workItem ? `${workItem.phase}:${workItem.needsUser ?? ""}` : ""}
            />
          )}
          {workItem?.canvasId && <ActiveWorkerCanvas featureId={feature.id} canvasId={workItem.canvasId} />}
        </>
      )}
      {activeTab === "artifacts" && feature.id && (
        <section className="flex flex-col gap-3" aria-label="Canvases">
          <FeatureArtifactsTab featureId={feature.id} />
        </section>
      )}
      {activeTab === "changes" && feature.branch ? (
        <ChangesTab key={feature.id} featureId={feature.id} initialFile={searchParams.get("file")} />
      ) : null}
      {activeTab === "terminal" && (
        <Section
          title="Panes"
          meta={`${paneCount} pane${paneCount === 1 ? "" : "s"}`}
          trailing={<span className="text-2xs text-faint">tmux layout</span>}
          panel={false}
          aria-label="Panes"
        >
          <TmuxPanes
            window={windowData}
            featureId={feature.id}
            projectSlug={project.tmuxSessionName}
            featureSlug={feature.tmuxWindowName}
          />
        </Section>
      )}
    </div>
  );
}

function MissingWindowState({ project, feature, onClose }: WindowBodyProps) {
  const togglePin = useProjectsStore((s) => s.togglePin);
  return (
    <div className="flex flex-col gap-4 w-full mx-auto max-w-[1280px] px-4 pt-1 pb-6 md:px-7 group-data-[pane-mode=worker]/workspace:max-w-none">
      <div className="flex items-center gap-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">Window not found</h1>
        <FeatureActionsMenu
          featureId={feature.id}
          featureName={feature.name}
          featureMode={feature.mode}
          branch={feature.branch}
          hasWorktree={!!feature.worktreePath}
          pinned={!!feature.pinnedAt}
          onTogglePin={() => void togglePin(feature.id)}
          onClose={onClose}
        />
      </div>
      <div className="rounded-lg border border-border-soft bg-panel p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">tmux window is missing</div>
          <div className="text-xs text-muted-foreground mt-1">
            The window "{feature.tmuxWindowName}" is not in session "{project.tmuxSessionName}". Create a shell pane to restore this feature window.
          </div>
        </div>
        <CreatePaneButton
          featureId={feature.id}
          projectSlug={project.tmuxSessionName}
          featureSlug={feature.tmuxWindowName}
          className="w-full sm:w-auto"
        />
      </div>
    </div>
  );
}

interface TmuxPanesProps {
  window: SnapshotWindow;
  featureId: string;
  projectSlug: string;
  featureSlug: string;
}

function TmuxPanes({ window, featureId, projectSlug, featureSlug }: TmuxPanesProps) {
  const panes = window.panes ?? [];
  const parsed = useMemo(() => parseTmuxLayout(window.windowLayout), [window.windowLayout]);
  const hasParseableLayout = !!parsed && parsed.leaves.length > 0 && panes.length > 0;

  if (panes.length === 0) {
    return (
      <EmptyPanesState
        featureId={featureId}
        projectSlug={projectSlug}
        featureSlug={featureSlug}
      />
    );
  }

  if (hasParseableLayout) {
    return (
      <TmuxLayoutBoard
        window={window}
        paneHref={(pane) =>
          pane.paneId
            ? `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(featureSlug)}/pane/${encodeURIComponent(pane.paneId)}`
            : null
        }
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {panes.map((pane) => (
        <PaneDetail key={pane.paneId} pane={pane} projectSlug={projectSlug} featureSlug={featureSlug} />
      ))}
    </div>
  );
}


interface EmptyPanesStateProps {
  featureId: string;
  projectSlug: string;
  featureSlug: string;
}

function EmptyPanesState({ featureId, projectSlug, featureSlug }: EmptyPanesStateProps) {
  return (
    <div className="rounded-lg border border-border-soft bg-panel p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">No panes in this window</div>
        <div className="text-xs text-muted-foreground mt-1">
          Create a shell pane to start working in this feature.
        </div>
      </div>
      <CreatePaneButton
        featureId={featureId}
        projectSlug={projectSlug}
        featureSlug={featureSlug}
        className="w-full sm:w-auto"
      />
    </div>
  );
}

interface CreatePaneButtonProps {
  featureId: string;
  projectSlug: string;
  featureSlug: string;
  className?: string;
}

function CreatePaneButton({ featureId, projectSlug, featureSlug, className }: CreatePaneButtonProps) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const createPane = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch(api.featurePanes(featureId), { method: "POST" });
      const body = await response.json().catch(() => ({})) as { paneId?: string; error?: string };
      if (!response.ok || !body.paneId) {
        toast.error(`Create pane failed: ${body.error ?? response.statusText}`);
        return;
      }
      toast.success("Pane created");
      navigate(
        `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(featureSlug)}/pane/${encodeURIComponent(body.paneId)}`
      );
    } catch (err) {
      toast.error(`Create pane failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Button size="sm" onClick={createPane} disabled={creating} className={className}>
      {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
      {creating ? "Creating…" : "Create pane"}
    </Button>
  );
}

function TabButton({
  active, onClick, children
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      // Tabs are furniture: a --sel fill marks the active one; no accent underline.
      className={cn(
        "h-7 rounded-sm px-2.5 text-xs font-medium transition-colors",
        active ? "bg-sel text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
