import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { useSnapshotStore } from "@/store/snapshot";
import type { ProjectWorker, Project } from "@/store/projects";
import { useAgentChatStore } from "@/store/agent-chat";
import { useWorkerPlan, useWorkerPlansStore } from "@/store/worker-plans";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";
import { TabMark } from "@/components/TabMark";
import { useTabFade } from "@/hooks/useTabFade";
import { parseTmuxLayout } from "@/lib/tmux";
import { errorText } from "@shared/error-text";
import { workerPaneHref } from "@/lib/worker-href";
import { selectSnapshotWindow } from "@/lib/snapshot-selectors";
import type { SnapshotWindow } from "@/lib/snapshot-types";
import type { WorkerTab } from "@/lib/worker-groups";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/Section";
import { QuestionCallout } from "@/components/QuestionCallout";
import { WorkerPlanCard } from "./plan/WorkerPlanCard";
import { WorkerCanvasList } from "./WorkerCanvasList";
import { useWorkerCanvases } from "./use-worker-canvases";
import { ChangesTab } from "./changes/ChangesTab";
import { ChangesSummaryLine } from "./ChangesSummaryLine";
import { TmuxLayoutBoard } from "./TmuxLayoutBoard";
import { PaneDetail } from "./PaneDetail";
import { ChatConversation } from "./chat/ChatConversation";
import { useWorkerQuestionTone } from "@/hooks/useWorkerQuestionTone";

/** One worker's tabs: Chat / Plan / Changes / Canvases / Terminal, in its
 *  thread's panel beside the chat (a phone's sheet). */
export function WorkerView({ project, worker, tab, onTabChange, actions }: {
  project: Project;
  worker: ProjectWorker;
  tab: WorkerTab;
  onTabChange: (tab: WorkerTab) => void;
  /** At the end of the tab row: the worker's menu. */
  actions?: React.ReactNode;
}) {
  const windowData = useSnapshotStore((s) => (
    selectSnapshotWindow(s.snapshot, project.tmuxSessionName, worker.tmuxWindowName)
  ));
  const plan = useWorkerPlan(worker.id);

  // One fetch for the worker's canvases: the plan links them by id from its
  // notes; the Canvases tab lists them.
  const canvasState = useWorkerCanvases(worker.id);
  const canvasTitles = useMemo(
    () => new Map((canvasState.canvases ?? []).map((c) => [c.id, c.title])),
    [canvasState.canvases]
  );
  const workerScope = useMemo(() => ({ type: "worker" as const, workerId: worker.id }), [worker.id]);
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
  const questionTone = useWorkerQuestionTone(worker.id);
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
  // Chat's question is the plan's, which the startup burst or a disconnect
  // can have missed: opening Chat fetches it, as opening Plan does through its
  // card. Whether it waits on the user is the thread's (useWorkerQuestionTone).
  const onChat = shown === "chat";
  useEffect(() => {
    if (!onChat) return;
    void useWorkerPlansStore.getState().fetchOne(worker.id).catch(() => {});
  }, [worker.id, onChat]);
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
        "px-3 pb-4"
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
        className="sticky top-[var(--worker-tabs-top,0px)] z-10 -mx-3 flex h-9 shrink-0 items-center gap-1 bg-background px-3 fade-below pointer-coarse:h-11 pointer-coarse:gap-2"
      >
      <div className="scroll-x-quiet relative flex min-w-0 flex-1 items-center gap-0.5 pointer-coarse:-my-2 pointer-coarse:py-2" role="tablist">
        <TabMark selected={shown} />
        <TabButton active={shown === "chat"} onClick={() => onTabChange("chat")}>Chat</TabButton>
        <TabButton active={shown === "plan"} onClick={() => onTabChange("plan")}>Plan</TabButton>
        {hasChanges ? (
          <TabButton active={shown === "changes"} onClick={() => onTabChange("changes")}>Changes</TabButton>
        ) : null}
        <TabButton active={shown === "canvases"} onClick={() => onTabChange("canvases")}>Canvases</TabButton>
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
          <div className="-mx-3 flex min-h-0 flex-1 flex-col">
            <ChatConversation scope={workerScope} />
          </div>
        </div>
      )}
      {shown === "plan" && (
        <>
          <WorkerPlanCard
            workerId={worker.id}
            projectSlug={project.tmuxSessionName}
            workerSlug={worker.tmuxWindowName}
            gitRemote={project.gitRemote}
            canvasTitles={canvasTitles}
          />
          {hasChanges && (
            <ChangesSummaryLine workerId={worker.id} />
          )}
        </>
      )}
      {shown === "canvases" && (
        <section className="flex flex-col gap-3" aria-label="Canvases">
          <WorkerCanvasList state={canvasState} />
        </section>
      )}
      {shown === "changes" && hasChanges ? (
        <ChangesTab key={worker.id} workerId={worker.id} uncommittedOnly={!worker.branch} />
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
              workerId={worker.id}
              projectSlug={project.tmuxSessionName}
              workerSlug={worker.tmuxWindowName}
            />
          </Section>
        ) : windowData === undefined ? (
          <p className="text-sm text-faint">Loading…</p>
        ) : (
          <MissingWindowNote project={project} worker={worker} />
        )
      )}
    </div>
  );
}

/** The tmux window is gone: say so, and offer to restore it. */
function MissingWindowNote({ project, worker }: { project: Project; worker: ProjectWorker }) {
  return (
    <div className="rounded-lg border border-border-soft bg-panel p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">tmux window is missing</div>
        <div className="text-xs text-muted-foreground mt-1">
          The window "{worker.tmuxWindowName}" is not in session "{project.tmuxSessionName}". Create a shell pane to restore this worker's window.
        </div>
      </div>
      <CreatePaneButton
        workerId={worker.id}
        projectSlug={project.tmuxSessionName}
        workerSlug={worker.tmuxWindowName}
        className="w-full sm:w-auto"
      />
    </div>
  );
}

interface TmuxPanesProps {
  window: SnapshotWindow;
  workerId: string;
  projectSlug: string;
  workerSlug: string;
}

function TmuxPanes({ window, workerId, projectSlug, workerSlug }: TmuxPanesProps) {
  const panes = window.panes ?? [];
  const parsed = useMemo(() => parseTmuxLayout(window.windowLayout), [window.windowLayout]);
  const hasParseableLayout = !!parsed && parsed.leaves.length > 0 && panes.length > 0;

  if (panes.length === 0) {
    return <EmptyPanesState workerId={workerId} projectSlug={projectSlug} workerSlug={workerSlug} />;
  }
  if (hasParseableLayout) {
    return (
      <TmuxLayoutBoard
        window={window}
        paneHref={(pane) => pane.paneId ? workerPaneHref(projectSlug, workerSlug, pane.paneId) : null}
      />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {panes.map((pane) => (
        <PaneDetail key={pane.paneId} pane={pane} projectSlug={projectSlug} workerSlug={workerSlug} />
      ))}
    </div>
  );
}

function EmptyPanesState({ workerId, projectSlug, workerSlug }: { workerId: string; projectSlug: string; workerSlug: string }) {
  return (
    <div className="rounded-lg border border-border-soft bg-panel p-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">No panes in this window</div>
        <div className="text-xs text-muted-foreground mt-1">
          Create a shell pane to start working in this worker's window.
        </div>
      </div>
      <CreatePaneButton workerId={workerId} projectSlug={projectSlug} workerSlug={workerSlug} className="w-full sm:w-auto" />
    </div>
  );
}

function CreatePaneButton({ workerId, projectSlug, workerSlug, className }: {
  workerId: string;
  projectSlug: string;
  workerSlug: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  const createPane = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const response = await fetch(api.workerPanes(workerId), { method: "POST" });
      const body = await response.json().catch(() => ({})) as { paneId?: string; error?: string };
      if (!response.ok || !body.paneId) {
        toast.error(`Create pane failed: ${body.error ?? response.statusText}`);
        return;
      }
      toast.success("Pane created");
      navigate(workerPaneHref(projectSlug, workerSlug, body.paneId));
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
