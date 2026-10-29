import { useEffect, useMemo } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useSnapshotStore } from "@/store/snapshot";
import { useProjectsStore, findFeatureBySlug } from "@/store/projects";
import type { Feature, Project } from "@/store/projects";
import { useFeatureWakeActive } from "@/store/wake-activity";
import { scopeKey, useAgentChatStore } from "@/store/agent-chat";
import { foldWaitingLines, threadWaitingLines } from "./chat/waiting-lines";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import { PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { isAsking, waitingOnYou } from "@shared/feature-state";
import { useFeaturePlan } from "@/store/feature-plans";
import { defaultWorkerTab, workerTabFromParam, type WorkerTab } from "@/lib/worker-groups";
import { FeatureTitle } from "./WindowPageHeader";
import { FeatureActionsMenu } from "./FeatureActionsMenu";
import { useWorkItemsStore } from "@/store/work-items";
import { shouldIgnoreGlobalEscape } from "@/lib/keyboard-targets";
import { cn } from "@/lib/utils";
import { WorkerView } from "./WorkerView";
import { BackLink, LoadingLine, StateAction, StateMessage } from "@/components/ViewState";
import { useProjectsArrival } from "@/hooks/useProjectsArrival";

export function WindowPage() {
  const params = useParams<{ projectSlug?: string; featureSlug?: string }>();
  const navigate = useNavigate();
  const project = useProjectsStore((s) => params.projectSlug ? s.bySlug[params.projectSlug] : undefined);
  const projectsArrival = useProjectsArrival();
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
    // Before the projects arrive nothing can be said about the worker.
    return (
      // A state message sits as far below the bar as "Thread not found";
      // loading keeps the page's own top, where the worker will show.
      <div className={cn(
        "flex flex-col gap-1 w-full mx-auto max-w-[1280px] px-4 pb-6 md:px-7 group-data-[pane-mode=worker]/workspace:max-w-none",
        projectsArrival === "loaded" || projectsArrival === "late" ? "pt-6" : "pt-1"
      )}>
        {projectsArrival === "loaded" ? (
          <StateMessage title="Worker not found" heading="h1" action={<BackLink to="/home">Back to Home</BackLink>}>
            It was archived, or the link is wrong.
          </StateMessage>
        ) : projectsArrival === "late" ? (
          <StateMessage title="Couldn't load this worker" heading="h1" action={<StateAction onClick={() => window.location.reload()}>Retry</StateAction>}>
            The list of projects hasn't arrived from Mandate. Check that it's running.
          </StateMessage>
        ) : <LoadingLine />}
      </div>
    );
  }

  return <WindowBody key={feature.id} project={project} feature={feature} />;
}

interface WindowBodyProps {
  project: Project;
  feature: Feature;
}

function WindowBody({ project, feature }: WindowBodyProps) {
  const windowData = useSnapshotStore((s) => (
    selectSnapshotWindow(s.snapshot, project.tmuxSessionName, feature.tmuxWindowName)
  ));
  const togglePin = useProjectsStore((s) => s.togglePin);
  const [searchParams, setSearchParams] = useSearchParams();

  const aggregate = windowData?.aggregate;
  const workItem = useWorkItemsStore((s) => {
    for (const it of s.items.values()) if (it.featureId === feature.id) return it;
    return null;
  });

  // Live signal: motion means the window is actually working right now.
  const aggregateStatus = aggregate?.status;
  const windowActive = aggregateStatus === "working" || aggregateStatus === "running_service";
  const wakeActive = useFeatureWakeActive(feature.id);
  const plan = useFeaturePlan(feature.id);
  // What the worker still waits on, for the line under its name on every
  // tab: its conversation is read for it, Chat open or not.
  useEffect(() => {
    void useAgentChatStore.getState().ensureThreadLoaded({ type: "worker", featureId: feature.id }).catch(() => {});
  }, [feature.id]);
  const workerThread = useAgentChatStore((s) => s.threadsByScope.get(scopeKey({ type: "worker", featureId: feature.id })));
  const workerMessages = workerThread?.messages;
  const workerMonitors = workerThread?.monitors;
  const waitingOn = useMemo(
    () => (workerMessages && workerMonitors ? foldWaitingLines(threadWaitingLines({ messages: workerMessages, monitors: workerMonitors }))?.lead ?? null : null),
    [workerMessages, workerMonitors]
  );
  // No tab in the URL: Chat when the worker waits on the user's answer, Plan otherwise.
  const tab = workerTabFromParam(searchParams.get("tab"))
    ?? defaultWorkerTab({ waiting: waitingOnYou(workItem?.failedAt ?? null, workItem?.failedKind ?? null), asking: isAsking(plan) });
  const setTab = (next: WorkerTab) => {
    const params = new URLSearchParams(searchParams);
    params.set("tab", next);
    if (next !== "changes") params.delete("file");
    setSearchParams(params, { replace: false });
  };

  if (windowData === undefined) {
    return (
      <div className="flex flex-col gap-4 w-full mx-auto max-w-[1280px] px-4 pt-1 pb-6 md:px-7">
        <LoadingLine />
      </div>
    );
  }

  const menu = (
    <FeatureActionsMenu
      featureId={feature.id}
      featureName={feature.name}
      featureMode={feature.mode}
      branch={feature.branch}
      hasWorktree={!!feature.worktreePath}
      window={windowData ?? undefined}
      pinned={!!feature.pinnedAt}
      onTogglePin={() => void togglePin(feature.id)}
      ownerThreadId={feature.ownerThreadId}
    />
  );

  // The window can be gone (its tmux window exited) while the worker is not:
  // its chat, plan and reports still work, and the Terminal tab offers the
  // restore. The header keeps the state pill either way: the Plan section
  // leaves the state to it.
  const title = (
    <FeatureTitle
      featureId={feature.id}
      window={windowData}
      featureName={feature.name}
      workItem={workItem}
      waitingOn={waitingOn}
      active={wakeActive || windowActive}
      workerRunning={wakeActive}
    />
  );

  return (
    // Chat is bounded by the pane (min-h-0), so a long history scrolls in the
    // chat's own list with the composer on screen; other tabs grow with their
    // content and the pane scrolls.
    <div className={cn("flex w-full flex-1 flex-col gap-4 pt-1", tab === "chat" && "min-h-0")}>
      {/* The title and actions live in the pane's header: the 52px header on
          a desktop, the top bar on a phone, in place of its breadcrumb — as on
          a phone's thread page, so the name shows once. */}
      <PaneHeaderTitle>{title}</PaneHeaderTitle>
      <PaneHeaderActions>{menu}</PaneHeaderActions>
      <WorkerView
        project={project}
        feature={feature}
        tab={tab}
        onTabChange={setTab}
        variant="page"
        initialFile={searchParams.get("file")}
      />
    </div>
  );
}
