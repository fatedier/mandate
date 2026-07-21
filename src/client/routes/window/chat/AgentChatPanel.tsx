import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useNavigate } from "react-router";
import { ArrowLeft, Forward, Loader2, MessagesSquare, MessageSquarePlus, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PaneZoomButton } from "@/components/PaneZoomButton";
import { useAgentChatStore, scopeKey, type AgentContextUsage } from "@/store/agent-chat";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useRouteFeature } from "@/hooks/useRouteFeature";
import { useProjectsStore } from "@/store/projects";
import { useWorkItemsStore } from "@/store/work-items";
import { useVoiceStore } from "@/store/voice";
import { useIsMobile } from "@/hooks/useIsMobile";
import { VoiceControlBar } from "@/routes/voice/VoiceControlBar";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { cn } from "@/lib/utils";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import { ScopePickerButton } from "./ScopePickerButton";

export function AgentChatPanel() {
  const navigate = useNavigate();
  const drawerOpen = useAgentChatStore((s) => s.drawerOpen);
  const drawerScope = useAgentChatStore((s) => s.drawerScope);
  const drawerMode = useAgentChatStore((s) => s.drawerMode);
  const setDrawerMode = useAgentChatStore((s) => s.setDrawerMode);
  const openDrawer = useAgentChatStore((s) => s.openDrawer);
  const closeDrawer = useAgentChatStore((s) => s.closeDrawer);
  const cancelWake = useAgentChatStore((s) => s.cancelWake);
  const startNewChat = useAgentChatStore((s) => s.startNewChat);
  const sideThread = useAgentChatStore((s) => s.sideThread);
  const sideParentScope = useAgentChatStore((s) => s.sideParentScope);
  const sideActive = useAgentChatStore((s) => s.sideActive);
  const startSideConversation = useAgentChatStore((s) => s.startSideConversation);
  const showMainConversation = useAgentChatStore((s) => s.showMainConversation);
  const showSideConversation = useAgentChatStore((s) => s.showSideConversation);
  const closeSideConversation = useAgentChatStore((s) => s.closeSideConversation);
  const sendSideMessage = useAgentChatStore((s) => s.sendSideMessage);
  const retrySideFailedMessage = useAgentChatStore((s) => s.retrySideFailedMessage);
  const deleteSideQueuedMessage = useAgentChatStore((s) => s.deleteSideQueuedMessage);
  const dismissSideWakeError = useAgentChatStore((s) => s.dismissSideWakeError);
  const cancelSideWake = useAgentChatStore((s) => s.cancelSideWake);
  const getSideSummaryDraft = useAgentChatStore((s) => s.getSideSummaryDraft);
  const transferSideSummary = useAgentChatStore((s) => s.transferSideSummary);
  const retargetSideSummary = useAgentChatStore((s) => s.retargetSideSummary);
  const sideTransferNeedsRetargetId = useAgentChatStore((s) => s.sideTransferNeedsRetargetId);
  const dismissWakeError = useAgentChatStore((s) => s.dismissWakeError);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const inProgressLines = useVoiceStore((s) => s.inProgressLines);
  const isMobile = useIsMobile();

  const { thread: mainThread, send, retry, deleteQueued, loadOlder } = useAgentChat(drawerScope);
  const thread = sideActive ? sideThread : mainThread;

  // NOTE: this deliberately does NOT defer the thread to null on first render.
  // An earlier version did, to keep the transcript off the dock's opening frame,
  // but that put a "Loading…" spinner on screen every single time the dock was
  // opened — a flash of failure for something that was never loading. The
  // transcript's own render window (ChatMessageList) now caps the first pass at
  // a couple of screenfuls, which is cheap enough that the shell does not need
  // to paint empty first.
  const queuedMessages = useMemo(() => {
    if (!thread) return [];
    return [...thread.pendingUserMessages.values()].filter((message) => message.status === "queued");
  }, [thread]);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [creatingNewChat, setCreatingNewChat] = useState(false);
  const [sideBusy, setSideBusy] = useState(false);
  const [sideError, setSideError] = useState("");
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryRetargetId, setSummaryRetargetId] = useState<string | null>(null);

  const featureName = useProjectsStore(useShallow((s) => {
    if (drawerScope?.type !== "worker") return null;
    for (const p of s.projects) {
      const f = p.features.find((ff) => ff.id === drawerScope.featureId);
      if (f) return { feature: f.name, project: p.name };
    }
    return null;
  }));

  // Feature on the *current route* — drives the feature scope tab. When the
  // user opens chat on a feature page, the tabs offer Manager and this
  // feature's chat; the effect below re-targets an open feature-scope drawer
  // when the route's feature changes.
  const routeFeature = useRouteFeature();
  // Unread counts for the scope tabs. Hooks must stay unconditional, so the
  // feature id is resolved (and guarded) inside the selector — it mirrors the
  // `featureTab` derivation below the drawerScope guard.
  const overviewUnread = useAgentChatStore(
    (s) => s.threadsByScope.get(scopeKey({ type: "manager" }))?.unreadAssistantCount ?? 0
  );
  const featureTabUnread = useAgentChatStore((s) => {
    const id = routeFeature?.id ?? (drawerScope?.type === "worker" ? drawerScope.featureId : null);
    if (!id) return 0;
    return s.threadsByScope.get(scopeKey({ type: "worker", featureId: id }))?.unreadAssistantCount ?? 0;
  });
  const activeFeatureScopeId = drawerScope?.type === "worker" ? drawerScope.featureId : null;
  useEffect(() => {
    if (!drawerOpen || !routeFeature || !activeFeatureScopeId) return;
    if (activeFeatureScopeId === routeFeature.id) return;
    openDrawer({ type: "worker", featureId: routeFeature.id });
  }, [activeFeatureScopeId, drawerOpen, openDrawer, routeFeature]);
  const handleSend = useCallback((
    content: string,
    attachments?: AgentMessageAttachment[],
    workItemRef?: { itemId: string; snapshotAt: string }
  ) => {
    if (sideActive) void sendSideMessage(content, attachments);
    else void send(content, attachments, workItemRef);
  }, [send, sendSideMessage, sideActive]);
  const handleRetry = useCallback((localId: string) => {
    if (sideActive) void retrySideFailedMessage(localId);
    else void retry(localId);
  }, [retry, retrySideFailedMessage, sideActive]);
  const handleDeleteQueued = useCallback((localId: string) => {
    if (sideActive) void deleteSideQueuedMessage(localId);
    else void deleteQueued(localId);
  }, [deleteQueued, deleteSideQueuedMessage, sideActive]);

  if (!drawerScope) return null;
  const wakeBusy = thread?.wakePhase.phase !== "idle";
  const canCancelWake = Boolean(wakeBusy && thread?.wakePhase.wakeId);
  const isManager = drawerScope.type === "manager";
  const fullscreen = drawerMode === "fullscreen";
  const parentBusy = mainThread?.wakePhase.phase !== "idle";

  // Scope tabs: Manager is always present. The feature tab shows
  // the current route's feature, or — when the drawer already shows a feature
  // that the route no longer matches — that feature, so the active scope
  // always has a visible tab.
  const featureTab: { id: string; name: string } | null =
    routeFeature ??
    (drawerScope.type === "worker" && featureName
      ? { id: drawerScope.featureId, name: featureName.feature }
      : null);

  const onConfirmNewChat = async () => {
    if (!drawerScope) return;
    setCreatingNewChat(true);
    try {
      await startNewChat(drawerScope);
    } finally {
      setCreatingNewChat(false);
      setConfirmOpen(false);
    }
  };

  const handleClose = () => {
    if (voiceMode && !isMobile) setVoiceMode(false);
    closeDrawer();
  };

  const handleOpenSide = async () => {
    if (sideThread) {
      if (sideParentScope && scopeKey(sideParentScope) !== scopeKey(drawerScope)) {
        openDrawer(sideParentScope);
      }
      showSideConversation();
      return;
    }
    setSideBusy(true);
    setSideError("");
    try {
      await startSideConversation(drawerScope);
    } catch (err) {
      setSideError(err instanceof Error ? err.message : String(err));
    } finally {
      setSideBusy(false);
    }
  };

  const handleOpenSummary = async () => {
    setSummaryOpen(true);
    setSummaryRetargetId(null);
    setSummaryBusy(true);
    setSideError("");
    try {
      setSummaryDraft(await getSideSummaryDraft());
    } catch (err) {
      setSideError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummaryBusy(false);
    }
  };

  const handleTransferSummary = async () => {
    if (!summaryDraft.trim()) return;
    setSummaryBusy(true);
    try {
      if (summaryRetargetId) {
        await retargetSideSummary(summaryRetargetId);
      } else {
        const result = await transferSideSummary(summaryDraft.trim());
        if (result.status === "needs_retarget") {
          setSummaryRetargetId(result.transferId);
          return;
        }
      }
      setSummaryOpen(false);
      showMainConversation();
    } catch (err) {
      setSideError(err instanceof Error ? err.message : String(err));
    } finally {
      setSummaryBusy(false);
    }
  };

  const handleRetargetPending = async () => {
    if (!sideTransferNeedsRetargetId) return;
    setSideBusy(true);
    setSideError("");
    try {
      await retargetSideSummary(sideTransferNeedsRetargetId);
    } catch (err) {
      setSideError(err instanceof Error ? err.message : String(err));
    } finally {
      setSideBusy(false);
    }
  };

  return (
    <>
      {/* Two headers share this markup, and they shed content by different
          rules — see the pill's own `compact` note for why one rule cannot
          cover both.
          Desktop (dock, draggable to any width) degrades by WIDTH: the context
          pill compresses then hides FIRST (its thresholds assume worst-case tab
          widths, so it can never squeeze the tabs), tab labels truncate only as
          a last resort near the dock's minimum width, and the action buttons
          never give way — nothing may overlap.
          Mobile (fullscreen sheet) has exactly ONE width, so those thresholds
          can never fire and a width rule would hide the pill forever. It no
          longer needs a content rule either — but only the FEATURE CHAT gained
          anything here: Manager-only and side conversation always had room,
          and the feature chat was the single state that did not, which is what
          collapsing the two scope tabs into one switch control fixed. With no
          state left to protect, the rule is simply `isMobile`. */}
      <div className="@container border-b border-border-soft px-4 py-3 flex flex-row items-center justify-between gap-2 shrink-0">
        <div className="min-w-0 flex items-center gap-1 overflow-hidden">
          {sideActive ? (
            <>
              <Button variant="ghost" size="icon" aria-label="Return to main conversation" onClick={showMainConversation}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span className="truncate text-xs font-semibold">Side</span>
              <span
                className={cn("h-2 w-2 shrink-0 rounded-full", parentBusy ? "bg-status-review" : "bg-primary")}
                title={parentBusy ? "Main conversation is running" : "Main conversation is idle"}
              />
            </>
          ) : isMobile ? (
            /* One control, one behaviour. A first pass kept the old one-tap
               swap wherever a counterpart existed and fell back to this picker
               where none did — coherent to describe, but it made the user work
               out which page they were on before they knew what a tap would do.
               A dropdown everywhere costs a second tap on a feature page and
               buys a control you never have to think about. */
            <ScopePickerButton
              currentLabel={isManager ? "Manager" : (featureName?.feature ?? "Feature")}
              currentScope={drawerScope}
              onPick={openDrawer}
            />
          ) : (
            <>
              <ScopeTab
                active={isManager}
                label="Manager"
                unread={overviewUnread}
                onClick={() => openDrawer({ type: "manager" })}
              />
              {featureTab && (
                <ScopeTab
                  flexible
                  active={drawerScope.type === "worker" && drawerScope.featureId === featureTab.id}
                  label={featureTab.name}
                  unread={featureTabUnread}
                  onClick={() => openDrawer({ type: "worker", featureId: featureTab.id })}
                />
              )}
            </>
          )}
          <ContextBudgetPill usage={thread?.contextUsage ?? null} compact={isMobile} />
        </div>
        <div className="flex items-center gap-0.5 md:gap-1 shrink-0">
          <PaneZoomButton
            pane="chat"
            zoomed={fullscreen}
            onClick={() => setDrawerMode(fullscreen ? "side" : "fullscreen")}
            className="hidden md:inline-flex"
          />
          {sideActive ? (
            <>
              <Button variant="ghost" size="icon" aria-label="Send summary to main conversation" onClick={() => void handleOpenSummary()}>
                <Forward className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close side conversation"
                disabled={sideBusy}
                onClick={() => void closeSideConversation()}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              aria-label={sideThread ? "Open side conversation" : "Start side conversation"}
              title={sideThread ? "Open side conversation" : "Start side conversation"}
              disabled={sideBusy || !mainThread?.threadId || mainThread.messages.length === 0}
              onClick={() => void handleOpenSide()}
            >
              {sideBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessagesSquare className="h-4 w-4" />}
            </Button>
          )}
          {!sideActive && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={isManager ? "New manager chat" : "New feature chat"}
              title={isManager ? "New manager chat" : "New feature chat"}
              disabled={creatingNewChat}
              onClick={() => setConfirmOpen(true)}
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            aria-label={isMobile ? "Close chat" : "Collapse chat dock"}
            onClick={handleClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {sideError && <div className="border-b border-destructive/20 px-4 py-2 text-xs text-destructive">{sideError}</div>}
      {sideTransferNeedsRetargetId && (
        <div className="flex items-center justify-between gap-2 border-b border-status-review/30 bg-status-review/10 px-4 py-2 text-xs">
          <span>Side summary needs a new main conversation target.</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={sideBusy}
            onClick={() => void handleRetargetPending()}
          >
            <Forward className="h-3.5 w-3.5" />
            Retarget
          </Button>
        </div>
      )}
      {thread === null ? (
        <div className="flex-1 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : (
        <>
          <ChatMessageList
            thread={thread}
            onLoadOlder={sideActive ? async () => {} : loadOlder}
            onRetryFailed={handleRetry}
            onDismissError={() => sideActive ? dismissSideWakeError() : dismissWakeError(drawerScope)}
            hideQueuedPending
            showEmptyHelp={!sideActive}
            inProgressLines={isManager && voiceMode ? inProgressLines : undefined}
            onOpenWorkItem={(id) => {
              // Navigate to the feature page bound to this work_item.
              // The work_item's needsUser / phase / summary now live in
              // the feature page header, so there's no separate inbox
              // surface to send the user to.
              const items = useWorkItemsStore.getState().items;
              const item = items.get(id);
              if (!item) return;
              const projects = useProjectsStore.getState().projects;
              const project = projects.find((p) => p.id === item.projectId);
              if (!project) return;
              const feature = project.features.find((f) => f.id === item.featureId);
              if (!feature) return;
              void navigate(`/projects/${encodeURIComponent(project.tmuxSessionName)}/features/${encodeURIComponent(feature.tmuxWindowName)}`);
            }}
          />
          {isManager && voiceMode ? (
            <VoiceControlBar />
          ) : (
            <ChatInput
              scope={sideActive ? undefined : drawerScope}
              onSend={handleSend}
              busyHint={wakeBusy}
              onCancel={canCancelWake
                ? () => { void (sideActive ? cancelSideWake() : cancelWake(drawerScope)); }
                : undefined}
              showMicButton={isManager && !sideActive}
              queuedMessages={queuedMessages}
              onDeleteQueuedMessage={handleDeleteQueued}
            />
          )}
        </>
      )}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {isManager ? "Start a new manager chat?" : "Start a new feature chat?"}
            </DialogTitle>
            <DialogDescription>
              The current conversation will be archived and preserved. The drawer will switch to a fresh conversation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" disabled={creatingNewChat} onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="default" disabled={creatingNewChat} onClick={() => void onConfirmNewChat()}>
              {creatingNewChat ? "Starting…" : "New chat"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={summaryOpen} onOpenChange={setSummaryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send to main conversation</DialogTitle>
            <DialogDescription>
              {summaryRetargetId
                ? "The original main conversation was replaced. Confirm the current main conversation as the new target."
                : "Edit the summary before it enters the main conversation."}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={summaryDraft}
            onChange={(event) => setSummaryDraft(event.target.value)}
            rows={10}
            disabled={summaryBusy}
            className="w-full resize-y rounded-md border border-border-soft bg-background px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <DialogFooter>
            <Button variant="ghost" disabled={summaryBusy} onClick={() => setSummaryOpen(false)}>Cancel</Button>
            <Button disabled={summaryBusy || !summaryDraft.trim()} onClick={() => void handleTransferSummary()}>
              {summaryBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Forward className="h-4 w-4" />}
              {summaryRetargetId ? "Send to current main" : "Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScopeTab({ active, label, unread, onClick, flexible = false }: {
  active: boolean;
  label: string;
  unread: number;
  onClick: () => void;
  /** Only the feature tab shrinks. "Manager" is a fixed, known-short label —
   *  letting it shrink is what produced "Assis…" at ordinary dock widths, since
   *  flex distributed the squeeze across both tabs instead of spending it all on
   *  the variable-length one. */
  flexible?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "relative flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors",
        flexible ? "min-w-0 max-w-40 shrink" : "shrink-0",
        active
          ? "bg-foreground/[0.07] text-foreground"
          : "text-chrome hover:bg-foreground/5 hover:text-foreground"
      )}
    >
      <span className="truncate">{label}</span>
      {unread > 0 && !active && (
        <span className="inline-flex min-w-[15px] h-3.5 items-center justify-center rounded-full bg-primary px-1 text-2xs font-semibold num text-primary-foreground">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}


function ContextBudgetPill({ usage, compact = false }: { usage: AgentContextUsage | null; compact?: boolean }) {
  const inputTokens = positiveNumberOrNull(usage?.inputTokens);
  const budgetTokens = positiveNumberOrNull(usage?.budgetTokens);
  const percent = inputTokens !== null && budgetTokens !== null
    ? Math.max(0, Math.round((inputTokens / budgetTokens) * 100))
    : null;
  const fillPercent = percent === null ? 0 : Math.min(percent, 100);
  const tone = percent !== null && percent >= 100
    ? "bg-status-input"
    : percent !== null && percent >= 85
      ? "bg-status-review"
      : "bg-primary";
  const title = inputTokens !== null && budgetTokens !== null
    ? `Last successful agent call used ${formatTokenCount(inputTokens)} of ${formatTokenCount(budgetTokens)} compression budget.`
    : "No successful agent context measurement yet.";

  // On desktop this degrades with the dock's own width (container queries on
  // the header); see the `compact` note on the className for why a phone
  // cannot use that rule.
  // Thresholds are sized against the WORST-CASE tab row (Manager + a
  // max-width feature tab + badges + buttons ≈ 27rem): the pill must be the
  // first thing to go — an informational pill never gets to truncate the
  // scope tabs, which are primary controls. Full pill ≥31rem, bare
  // percentage ≥27rem, hidden below.
  return (
    <div
      className={cn(
        "shrink-0 items-center gap-1.5 rounded-md border border-border-soft bg-muted/30 px-2 py-1 text-2xs font-medium text-muted-foreground",
        // Two rules on purpose. The desktop dock can be dragged to any width,
        // so it degrades by width. A phone has exactly one width — the header's
        // content box measures 358px at 390px, which can never reach 27rem — so
        // a width rule there is always false and would hide the pill forever.
        // The feature chat was the one mobile state without room for the pill;
        // collapsing its two scope tabs into one switch control bought that
        // state the ~40px it was missing, so the phone's rule is now simply
        // `isMobile`. One rule covering both would have to lie to one of them.
        compact ? "flex" : "hidden @[27rem]:flex"
      )}
      title={title}
      aria-label={title}
    >
      <span className="hidden h-1.5 w-9 overflow-hidden rounded-full bg-muted @[31rem]:block">
        <span
          className={cn("block h-full rounded-full", tone)}
          style={{ width: `${fillPercent}%` }}
        />
      </span>
      <span className="whitespace-nowrap">
        <span className="hidden @[31rem]:inline">Context </span>
        {percent === null ? "--" : `${percent}%`}
      </span>
    </div>
  );
}

function positiveNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}
