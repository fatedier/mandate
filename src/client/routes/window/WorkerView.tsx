import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useSnapshotStore } from "@/store/snapshot";
import type { Feature, Project } from "@/store/projects";
import { useAgentChatStore } from "@/store/agent-chat";
import { useWorkItemsStore } from "@/store/work-items";
import { useFeaturePlan, useFeaturePlansStore } from "@/store/feature-plans";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { TabMark } from "@/components/TabMark";
import { useTabFade } from "@/hooks/useTabFade";
import { parseTmuxLayout } from "@/lib/tmux";
import { errorText } from "@shared/error-text";
import { featurePaneHref } from "@/lib/feature-href";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkerTab } from "@/lib/worker-groups";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/Section";
import { QuestionCallout } from "@/components/QuestionCallout";
import { FeaturePlanCard } from "./plan/FeaturePlanCard";
import { FeatureCanvasList } from "./FeatureCanvasList";
import { useFeatureCanvases } from "./use-feature-canvases";
import { ChangesTab } from "./changes/ChangesTab";
import { ChangesSummaryLine } from "./ChangesSummaryLine";
import { TmuxLayoutBoard } from "./TmuxLayoutBoard";
import { PaneDetail } from "./PaneDetail";
import { ChatConversation } from "./chat/ChatConversation";
import { useWorkerQuestionTone } from "@/hooks/useWorkerQuestionTone";

/** One worker's tabs: Chat / Plan / Changes / Canvases / Terminal. The worker
 *  page shows it full-page; a thread's panel shows it beside the chat. */
export function WorkerView({ project, feature, tab, onTabChange, variant, initialFile = null, actions }: {
  project: Project;
  feature: Feature;
  tab: WorkerTab;
  onTabChange: (tab: WorkerTab) => void;
  variant: "page" | "panel";
  /** At the end of the tab row: the worker's menu in the thread's panel
   *  (the page has it in its header). */
  actions?: React.ReactNode;
  /** Changes: the file to open first (the page keeps it in the URL). */
  initialFile?: string | null;
}) {
  const windowData = useSnapshotStore((s) => (
    selectSnapshotWindow(s.snapshot, project.tmuxSessionName, feature.tmuxWindowName)
  ));
  const plan = useFeaturePlan(feature.id);

  // One fetch for the feature's canvases: the plan links them by id from its
  // notes; the Canvases tab lists them.
  const canvasState = useFeatureCanvases(feature.id);
  const canvasTitles = useMemo(
    () => new Map((canvasState.canvases ?? []).map((c) => [c.id, c.title])),
    [canvasState.canvases]
  );
  const workerScope = useMemo(() => ({ type: "worker" as const, featureId: feature.id }), [feature.id]);
  const sendMessage = useAgentChatStore((s) => s.sendMessage);
  // Its conversation is read whichever tab is open: the menu beside the tabs
  // says how full the worker's context is, and that comes with the read.
  useEffect(() => {
    void useAgentChatStore.getState().ensureThreadLoaded(workerScope).catch(() => {});
  }, [workerScope]);
  const aggregateStatus = windowData?.aggregate?.status;
  const windowActive = aggregateStatus === "working" || aggregateStatus === "running_service";
  // The question the worker is waiting on, answered above its chat.
  const asked = plan?.openQuestions[0];
  const questionTone = useWorkerQuestionTone(feature.id);
  const reply = async (text: string) => {
    const outcome = await sendMessage(workerScope, text);
    // sendMessage never rejects; rethrow so QuestionCallout shows its error state.
    if (outcome === "failed") throw new Error("send failed");
  };
  // What a worker changed is its directory against git: any worker of a git
  // project has it, one that works in the project's own directory too.
  const hasChanges = project.isGit;
  const shown: WorkerTab = tab === "changes" && !hasChanges ? "plan" : tab;
  // What the tab chosen next shows, under the pinned tabs, fades in.
  const tabsRef = useRef<HTMLDivElement>(null);
  useTabFade(tabsRef, shown);
  // Chat's question needs both the plan (the question) and the work item
  // (that it waits on input); either can be missing — the startup burst or a
  // disconnect missed the plan, the startup list is capped. Opening Chat
  // fetches them, as opening Plan does through its card (one lookup per tab).
  const onChat = shown === "chat";
  useEffect(() => {
    if (!onChat) return;
    void useFeaturePlansStore.getState().fetchOne(feature.id).catch(() => {});
    void useWorkItemsStore.getState().fetchByFeature(feature.id).catch(() => {});
  }, [feature.id, onChat]);
  const paneCount = windowData?.panes?.length ?? 0;

  return (
    <div
      // Chat fills what it is given and sizes its list to that height; the
      // other tabs grow with what they show and scroll with the pane, so the
      // pinned tabs have the whole height to stay pinned in (a box held to
      // the pane's height let them go after a screen). A sheet reads this
      // mark to hold its own height only around a chat.
      data-fills-height={shown === "chat" || undefined}
      className={cn(
        // --worker-pinned: how far down the pane its pinned bars reach (a
        // sheet's header above the tabs, then the tabs' 36px, 44px on a
        // touch screen), for what pins or scrolls itself into view below.
        "flex w-full flex-1 flex-col gap-4 [--worker-pinned:calc(var(--worker-tabs-top,0px)+2.25rem)] pointer-coarse:[--worker-pinned:calc(var(--worker-tabs-top,0px)+2.75rem)]",
        // Chat scrolls in its own list, below the tabs; elsewhere what the
        // keyboard brings into view must not land behind them.
        shown === "chat" ? "min-h-0" : "scroll-below-pinned",
        variant === "panel" ? "px-3 pb-4" : "mx-auto px-4 pb-6 md:px-7",
        // Diffs are the one surface that earns the full width: side-by-side
        // columns starve inside the reading-width cap the other tabs keep.
        variant === "page" && (shown === "changes" ? "max-w-none" : "max-w-[1280px]")
      )}
    >
      {/* The tabs scroll on a narrow phone; the menu beside them stays in
          view. */}
      {/* 8px between the tabs and the menu on a touch screen: the menu's
          touch area reaches 8px past it, over a tab the row has cut. */}
      {/* Pinned on every tab: on all but Chat the pane scrolls
          and the tabs went with it. Its ground spans the view's padding, and
          what scrolls under it fades into the 16px gap below. 44px on a
          touch screen: the tabs' touch areas stay inside it, where nothing
          pinned above or below can clip or cover them. */}
      <div
        ref={tabsRef}
        data-slot="worker-tabs"
        className={cn(
          "sticky top-[var(--worker-tabs-top,0px)] z-10 flex h-9 shrink-0 items-center gap-1 bg-background fade-below pointer-coarse:h-11 pointer-coarse:gap-2",
          variant === "panel" ? "-mx-3 px-3" : "-mx-4 px-4 md:-mx-7 md:px-7"
        )}
      >
      <div className="scroll-x-quiet relative flex min-w-0 flex-1 items-center gap-0.5 pointer-coarse:-my-2 pointer-coarse:py-2" role="tablist">
        <TabMark selected={shown} />
        <TabButton active={shown === "chat"} onClick={() => onTabChange("chat")}>Chat</TabButton>
        <TabButton active={shown === "plan"} onClick={() => onTabChange("plan")}>Plan</TabButton>
        {hasChanges ? (
          <TabButton active={shown === "changes"} onClick={() => onTabChange("changes")}>Changes</TabButton>
        ) : null}
        <TabButton active={shown === "reports"} onClick={() => onTabChange("reports")}>Canvases</TabButton>
        <TabButton active={shown === "terminal"} onClick={() => onTabChange("terminal")}>
          Terminal
          {windowActive && (
            <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-live animate-live align-middle" />
          )}
        </TabButton>
      </div>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>

      {shown === "chat" && (
        // The height it is given, not "at least 60vh": the list scrolls in
        // its own box and the composer sits at the bottom, empty or long.
        <div className="flex min-h-0 flex-1 flex-col">
          {asked && <QuestionCallout question={asked} onSend={reply} tone={questionTone} />}
          {/* The chat brings its own gutters (chat-column.ts); this cancels
              the view's padding so they apply once, as in a thread. */}
          <div className={cn("flex min-h-0 flex-1 flex-col", variant === "panel" ? "-mx-3" : "-mx-4 md:-mx-7")}>
            <ChatConversation scope={workerScope} />
          </div>
        </div>
      )}
      {shown === "plan" && (
        <>
          <FeaturePlanCard
            featureId={feature.id}
            projectSlug={project.tmuxSessionName}
            featureSlug={feature.tmuxWindowName}
            gitRemote={project.gitRemote}
            canvasTitles={canvasTitles}
            // The page's header shows the state; the panel has no such header.
            showState={variant === "panel"}
          />
          {hasChanges && (
            <ChangesSummaryLine featureId={feature.id} />
          )}
        </>
      )}
      {shown === "reports" && (
        <section className="flex flex-col gap-3" aria-label="Canvases">
          <FeatureCanvasList state={canvasState} />
        </section>
      )}
      {shown === "changes" && hasChanges ? (
        <ChangesTab key={feature.id} featureId={feature.id} initialFile={initialFile} uncommittedOnly={!feature.branch} />
      ) : null}
      {shown === "terminal" && (
        windowData ? (
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
        ) : windowData === undefined ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <MissingWindowNote project={project} feature={feature} />
        )
      )}
    </div>
  );
}

/** The tmux window is gone: say so, and offer to restore it. */
function MissingWindowNote({ project, feature }: { project: Project; feature: Feature }) {
  return (
    <div className="rounded-lg border border-border-soft bg-panel p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">tmux window is missing</div>
        <div className="text-xs text-muted-foreground mt-1">
          The window "{feature.tmuxWindowName}" is not in session "{project.tmuxSessionName}". Create a shell pane to restore this worker's window.
        </div>
      </div>
      <CreatePaneButton
        featureId={feature.id}
        projectSlug={project.tmuxSessionName}
        featureSlug={feature.tmuxWindowName}
        className="w-full sm:w-auto"
      />
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
    return <EmptyPanesState featureId={featureId} projectSlug={projectSlug} featureSlug={featureSlug} />;
  }
  if (hasParseableLayout) {
    return (
      <TmuxLayoutBoard
        window={window}
        paneHref={(pane) => pane.paneId ? featurePaneHref(projectSlug, featureSlug, pane.paneId) : null}
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

function EmptyPanesState({ featureId, projectSlug, featureSlug }: { featureId: string; projectSlug: string; featureSlug: string }) {
  return (
    <div className="rounded-lg border border-border-soft bg-panel p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">No panes in this window</div>
        <div className="text-xs text-muted-foreground mt-1">
          Create a shell pane to start working in this worker's window.
        </div>
      </div>
      <CreatePaneButton featureId={featureId} projectSlug={projectSlug} featureSlug={featureSlug} className="w-full sm:w-auto" />
    </div>
  );
}

function CreatePaneButton({ featureId, projectSlug, featureSlug, className }: {
  featureId: string;
  projectSlug: string;
  featureSlug: string;
  className?: string;
}) {
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
      navigate(featurePaneHref(projectSlug, featureSlug, body.paneId));
    } catch (err) {
      toast.error(`Create pane failed: ${errorText(err)}`);
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

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      // Tabs are furniture: a --sel fill marks the active one (the row's
      // sliding TabMark); no accent underline.
      className={cn(
        "hit relative h-7 shrink-0 whitespace-nowrap rounded-sm px-2.5 text-xs font-medium transition-colors",
        active ? "text-foreground" : "text-chrome hover:bg-sel hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
