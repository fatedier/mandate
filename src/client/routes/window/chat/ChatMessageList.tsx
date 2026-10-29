import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import type { AgentMessage, ThreadState } from "@/store/agent-chat";
import { WakeFailureLine } from "./WakeFailureLine";
import { actionableFailureId } from "./failure-action";
import { Button } from "@/components/ui/button";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { cn } from "@/lib/utils";
import { ArrowDown } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { useReasoningHeadingStore } from "@/store/reasoning-heading";
import { useReplyActivityStore } from "@/store/reply-activity";
import { useInterruptedWakesStore } from "@/store/interrupted-wakes";
import { AssistantMessage } from "./AssistantMessage";
import { answeredQuestions, askOpenKey, openAskPausesFollow, skippedQuestions, withdrawnQuestions } from "./ask-lines";
import { StreamingAssistantMessage } from "./StreamingAssistantMessage";
import { WorkingIndicator } from "./WorkingIndicator";
import { workingLine } from "./working-line";
import { workedForByWake } from "./worked-for";
import { callsShownAsEndings, rowDrawsWork, turnEndings, type TurnEnding } from "./turn-endings";
import { CompressionSummaryMessage } from "./CompressionSummaryMessage";
import { FeatureMessageLine } from "./FeatureMessageLine";
import { HandoffCard } from "@/routes/global/HandoffCard";
import { openSentTextPausesFollow, turnHandoffs, useWorkerChatHrefs } from "@/routes/global/handoff-tools";
import { WorkerReportCard } from "./WorkerReportCard";
import { SubagentResultCard } from "./SubagentResultCard";
import { CommandResultLine } from "./CommandResultLine";
import { commandResultOf, startedTask, subagentResultOf } from "./subagent-lines";
import { workerReportOf } from "@shared/worker-report";
import { projectChangeOf } from "@shared/project-change";
import { answersOf, askedOf } from "@shared/questions";
import { mentionsOf } from "@shared/mentions";
import { ChatProvenanceLine } from "./ChatProvenanceLine";
import { causeForTriggerMessage, provenanceForWake, triggerReason, type ChatProvenance } from "./chatProvenance";
import { ContextBoundary } from "./ContextBoundary";
import { pairWakeCauses } from "./wake-causes";
import type { ToolCallSpec } from "./tool-run-summary";
import { collectToolNames } from "./tool-details/names";
import { PendingMonitorsContext, ToolNamesContext } from "./tool-details/names-context";
import { waitingLines } from "./waiting-lines";
import { WaitingLines } from "./WaitingLines";
import { groupToolRuns } from "./group-tool-runs";
import { runningToolCallId } from "./running-call";
import type { VoiceTranscriptLine } from "@/store/voice";
import { datedRows, dividerSeedFor, foldOpenKey, foldsWhenLong, liveRunRow, openFoldPausesFollow, openRunPausesFollow, rendersNothing, transcriptItems, wakeReasonOf, type TranscriptRow } from "./transcript-rows";
import { rowActions } from "./row-actions";
import { AssistantReplyGroup, ChatDateSeparator, EphemeralAssistantBubble, RowFrame } from "./TranscriptRowFrame";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useThreadWorkers } from "@/hooks/useThreadWorkers";
import { featureMessageMetadata } from "@shared/feature-message";
import { useGlobalAgentStore } from "@/store/global-agent";
import { displayGlobalAgentName } from "@shared/global-agent-name";
import { CHAT_COLUMN_MAX_PX, CHAT_GUTTER_CLASS } from "./chat-column";
import { useTranscriptViewport, type ApplyOlder } from "./useTranscriptViewport";
import { useArrivingRows, type ShownRow } from "./arriving-rows";

/** How long a question's line flashes when an answer's quote leads to it. */
const QUESTION_FLASH_MS = 1400;

/** Rows that are not the user's own words, though the server stores them as
 *  the user's: each is drawn as something else (renderTranscriptItem). */
const NOT_THE_USERS_WORDS = new Set(["compression", "restart-recovery", "worker-report", "feature-message", "thread-notice", "project-change", "subagent-result", "command-result", "page-input", "page-result"]);

/** A row drawn as the user's bubble: a send still on its way, or the user's
 *  own words. */
function isUserBubble(item: TranscriptRow): boolean {
  if (item.kind === "pending") return true;
  const m = item.message;
  return m.role === "user" && m.content.type === "text" && !triggerReason(m) && !NOT_THE_USERS_WORDS.has(m.source);
}

/** A row's time for the hover time in the gap above it. A reply under the
 *  cause line of the event that woke it shows that event's, as its first line
 *  is the event. None for the user's bubble, whose action line has it; none
 *  for the agent's other rows (a turn's time is on its last reply's line, and
 *  a tool summary's would repeat the row above within seconds); none for a
 *  row that shows its time itself (a failed turn). */
function rowTimeOf(item: TranscriptRow, userBubble: boolean): string | null {
  if (userBubble || item.kind !== "msg") return null;
  if (item.message.content.type === "wake_failure") return null;
  if (item.message.role === "assistant") return item.cause?.createdAt ?? null;
  return item.message.createdAt;
}

const NO_CALLS: ReadonlySet<string> = new Set();

/** The sentence a turn closed with, when its ending is one. */
function closingOf(ending: TurnEnding | undefined): string | undefined {
  return ending?.kind === "settled" ? ending.reason : undefined;
}

/** A row's key, the one its element carries. */
function rowKeyOf(item: TranscriptRow): string {
  return item.kind === "pending" ? item.pending.localId : item.message.id;
}

/** A drawn row, for telling what arrived (arriving-rows). */
function shownRowOf(item: TranscriptRow, key: string): ShownRow {
  return item.kind === "pending"
    ? { key, kind: "pending", localId: item.pending.localId }
    : { key, kind: "message", message: item.message };
}

export interface ChatMessageListProps {
  thread: ThreadState;
  /** Loads the page before the oldest loaded, its write passed to `apply`. */
  onLoadOlder: (apply: ApplyOlder) => Promise<void>;
  /** Sends a message that failed to send again (its Retry). Absent, no Retry. */
  onRetryFailed?: (localId: string) => void;
  /** Runs the newest failed wake again (its line's Retry). Absent, no Retry. */
  onRetryWake?: (wakeId: string) => Promise<void> | void;
  /** Asks a stopped turn to go on (its line's Continue). */
  onContinue?: () => Promise<void> | void;
  hideQueuedPending?: boolean;
  /** The empty conversation's help: what the agent can do, and for a worker
   *  an example question about its feature. Null, none. */
  emptyHelp?: "worker" | "manager" | null;
  /** Shown instead of "No messages yet" (and its help). */
  emptyState?: ReactNode;
  /** Ephemeral in-progress voice transcripts to render at the bottom.
   *  Keyed by speaker; null when no streaming for that speaker. */
  inProgressLines?: { user: VoiceTranscriptLine | null; assistant: VoiceTranscriptLine | null };
  /** Opens a worker from its report card. */
  onOpenWorker?: (featureId: string) => void;
  /** The conversation's open questions, by id: the line where one was asked
   *  says whether it still waits. Absent, each reads as answered. */
  openQuestionIds?: ReadonlySet<string>;
}

const STREAMING_RENDER_INTERVAL_MS = 80;

function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const lastUpdateRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    const elapsed = now - lastUpdateRef.current;
    if (elapsed >= intervalMs) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastUpdateRef.current = now;
      setThrottled(value);
      return;
    }

    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      lastUpdateRef.current = Date.now();
      timerRef.current = null;
      setThrottled(value);
    }, intervalMs - elapsed);

    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [value, intervalMs]);

  return throttled;
}

export function ChatMessageList({
  thread,
  onLoadOlder,
  onRetryFailed,
  onRetryWake,
  onContinue,
  hideQueuedPending = false,
  emptyHelp = null,
  emptyState,
  inProgressLines,
  onOpenWorker,
  openQuestionIds = NO_CALLS,
}: ChatMessageListProps) {
  // Relayed messages say who passed them on: the global agent, by its name.
  const agentName = useGlobalAgentStore((s) => displayGlobalAgentName(s.agent?.name ?? ""));
  // What the reader opened in this transcript: runs and their calls, long
  // messages unfolded, and what a card says was sent (foldOpenKey).
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  const isMobile = useIsMobile();
  const streamingText = useThrottledValue(
    thread.streamingAssistant?.totalText ?? "",
    STREAMING_RENDER_INTERVAL_MS
  );
  const { renderItems, toolResultsByCallId, hiddenQueuedCount } = useMemo(
    () => transcriptItems(thread.messages, thread.pendingUserMessages, hideQueuedPending),
    [hideQueuedPending, thread.messages, thread.pendingUserMessages]
  );
  const questionMarks = useMemo(
    () => ({ open: openQuestionIds, withdrawn: withdrawnQuestions(thread.messages), skipped: skippedQuestions(thread.messages), answers: answeredQuestions(thread.messages) }),
    [openQuestionIds, thread.messages]
  );
  // The questions whose line the transcript draws, where an answer's quote
  // leads: asked by a call of a loaded turn (a page can start at a call's
  // result, its turn not loaded, and then no line is drawn).
  const askedHere = useMemo(() => {
    const calls = new Set(thread.messages.flatMap((m) => (m.content.type === "assistant" ? (m.content.toolCalls ?? []).map((c) => c.toolCallId) : [])));
    return new Set(thread.messages.flatMap((m) => {
      if (m.content.type !== "tool_result" || !calls.has(m.content.toolCallId)) return [];
      const asked = askedOf(m.content, m.createdAt);
      return asked ? [asked.id] : [];
    }));
  }, [thread.messages]);
  // A worker's reply names it only when the thread has more than one: its
  // live workers, and every worker whose reply is in the transcript (an
  // archived one included).
  const threadWorkers = useThreadWorkers(thread.threadId ?? "");
  const nameReplies = useMemo(() => {
    const ids = new Set(threadWorkers.map((w) => w.featureId));
    for (const m of thread.messages) {
      if (m.source !== "feature-message") continue;
      const id = featureMessageMetadata(m.content)?.featureId;
      if (id) ids.add(id);
    }
    return ids.size > 1;
  }, [threadWorkers, thread.messages]);

  const activeWakeId = thread.wakePhase.phase === "idle" ? null : thread.wakePhase.wakeId;
  // The one failure row that offers Retry or Continue (see actionableFailureId).
  const pendingSend = [...thread.pendingUserMessages.values()].some((p) => p.status !== "sent");
  const actionable = actionableFailureId(thread.messages, pendingSend, thread.wakePhase.phase === "idle" && !thread.compressionPhase);
  const failureAction = (message: AgentMessage): (() => Promise<void>) | undefined => {
    if (message.id !== actionable || message.content.type !== "wake_failure" || !message.wakeId) return undefined;
    const wakeId = message.wakeId;
    // Retry reruns a wake that errored; any stop is continued instead.
    if (message.content.status !== "error") return onContinue ? async () => { await onContinue(); } : undefined;
    return onRetryWake ? async () => { await onRetryWake(wakeId); } : undefined;
  };
  const runningCallId = useMemo(
    () => runningToolCallId(thread.messages, activeWakeId, (id) => toolResultsByCallId.has(id)),
    [thread.messages, activeWakeId, toolResultsByCallId]
  );
  const reasoningHeading = useReasoningHeadingStore((s) => (activeWakeId ? s.byWake.get(activeWakeId) ?? null : null));
  const replyMovedAt = useReplyActivityStore((s) => (activeWakeId ? s.byWake.get(activeWakeId) ?? null : null));
  const working = workingLine({
    wakePhase: thread.wakePhase,
    compressionPhase: thread.compressionPhase,
    streaming: thread.streamingAssistant,
    messages: thread.messages,
    reasoningHeading,
    replyMovedAt
  });
  // What the agent is still waiting on: shown where the working line stands,
  // once no turn runs (a turn's own reply or working line has that place).
  const turnRunning = thread.wakePhase.phase === "thinking" || thread.streamingAssistant !== null;
  const pendingMonitorIds = useMemo(() => new Set(thread.monitors.map((monitor) => monitor.id)), [thread.monitors]);
  const bottomEphemeralKey = [
    turnRunning ? "" : thread.monitors.map((monitor) => monitor.id).join(","),
    working?.verb ?? "",
    inProgressLines?.user?.text ?? "",
    inProgressLines?.assistant?.text ?? ""
  ].join("\u0001");

  // What the thread called its panes and features, for the tool calls that
  // name them by id. Over every loaded message, not the rendered window: the
  // spawn that named a pane is often far above the reads of it.
  const toolNames = useMemo(
    () => collectToolNames(
      thread.messages.flatMap((m) => (m.content.type === "assistant" ? (m.content.toolCalls ?? []) as ToolCallSpec[] : [])),
      toolResultsByCallId
    ),
    [thread.messages, toolResultsByCallId]
  );
  const waiting = useMemo(() => waitingLines(thread.monitors, toolNames), [thread.monitors, toolNames]);

  // A run open in the transcript pauses following new messages, so it is not
  // scrolled away while being read. Derived from the runs among the loaded
  // rows (all drawn once the first window is released), never from the marks
  // alone: a mark can outlive what it opened (the run lost its messages, or
  // the pane went phone-sized, where nothing opens in place), and a pause held
  // by something no one can see is a transcript that silently stops following.
  const loadedFrom = thread.hasMoreOlder ? thread.messages[0]?.createdAt ?? "" : null;
  const turnStarts = useMemo(() => {
    const starts = new Map<string, string>();
    for (const m of thread.messages) if (m.wakeId && m.wakeStartedAt) starts.set(m.wakeId, m.wakeStartedAt);
    return starts;
  }, [thread.messages]);
  // The turns that have not ended: the one under way, and one still writing
  // (after a reconnect the stream can be back before the phase is).
  const streamingWakeId = thread.streamingAssistant?.wakeId ?? null;
  const liveWakeIds = useMemo(
    () => new Set([activeWakeId, streamingWakeId].filter((id): id is string => id !== null)),
    [activeWakeId, streamingWakeId]
  );
  // The turns a person stopped: their loaded messages say so, and for one
  // stopped while the page was open, read before it ended, the page heard.
  const stoppedHere = useInterruptedWakesStore((s) => s.ids);
  const interruptedWakeIds = useMemo(() => {
    const ids = new Set(stoppedHere);
    for (const m of thread.messages) if (m.wakeId && m.wakeInterrupted) ids.add(m.wakeId);
    return ids;
  }, [thread.messages, stoppedHere]);
  const reasonOf = useCallback((m: AgentMessage) => wakeReasonOf(m, thread.wakeReasonsById), [thread.wakeReasonsById]);
  // A call drawn as its turn's closing sentence is in no run (turnEndings):
  // the run it opened may have left the page with it. Read over every loaded
  // row, as the pause is, and only while something is open.
  const closingCallsLoaded = useMemo(
    () => expandedToolIds.size === 0 ? NO_CALLS : callsShownAsEndings(turnEndings(groupToolRuns(renderItems), {
      loaded: renderItems, loadedFrom, turnStarts, liveWakeIds, interruptedWakeIds, results: toolResultsByCallId, draws: () => true, reasonOf
    })),
    [expandedToolIds, renderItems, loadedFrom, turnStarts, liveWakeIds, interruptedWakeIds, toolResultsByCallId, reasonOf]
  );
  // A subagent that started is a line of its own (AssistantMessage), in no
  // run: a run opened while its call waited for its answer left with it.
  const drawnOutOfRuns = useMemo(() => {
    if (expandedToolIds.size === 0) return closingCallsLoaded;
    const ids = new Set(closingCallsLoaded);
    for (const item of renderItems) {
      if (item.kind !== "msg") continue;
      for (const step of [item.message, ...(item.runTail ?? [])]) {
        if (step.content.type !== "assistant") continue;
        for (const call of (step.content.toolCalls ?? []) as ToolCallSpec[]) {
          if (startedTask(call, toolResultsByCallId.get(call.toolCallId))) ids.add(call.toolCallId);
        }
      }
    }
    return ids;
  }, [expandedToolIds, renderItems, toolResultsByCallId, closingCallsLoaded]);
  const expansionPausesFollow = useMemo(
    () => openRunPausesFollow(renderItems, expandedToolIds, isMobile, drawnOutOfRuns) || openFoldPausesFollow(renderItems, expandedToolIds) ||
      openSentTextPausesFollow(renderItems, toolResultsByCallId, expandedToolIds) ||
      openAskPausesFollow(renderItems, toolResultsByCallId, expandedToolIds, openQuestionIds),
    [isMobile, expandedToolIds, renderItems, toolResultsByCallId, drawnOutOfRuns, openQuestionIds]
  );
  const columnRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const {
    scrollRef, onScroll, onWheel, onTouchStart, onTouchMove, renderWindow,
    showLatest, scrollToLatest, loadingOlder, olderError, retryOlder, filling
  } = useTranscriptViewport({
    threadId: thread.threadId,
    itemCount: renderItems.length,
    hasMoreOlder: thread.hasMoreOlder,
    loadOlder: onLoadOlder,
    followPaused: expansionPausesFollow,
    // When the newest message this page sent was written: a send of the
    // reader's own takes them to the end.
    sentAt: newestSentAt(thread.pendingUserMessages),
    // The newest row by key, not by count: once the cache holds its 500, a
    // new message pushes the oldest out and the count stays.
    growthKey: [renderItems.length > 0 ? rowKeyOf(renderItems[renderItems.length - 1]!) : "", streamingText, bottomEphemeralKey].join("\u0001")
  });
  // An answer's quote leads to its question's line: opened, scrolled to, and
  // flashed as a setting the page jumps to is. At once, not smoothly: the
  // scroll has left the end before the next streamed word is read, so
  // following the end cannot take the reader back down. Stable, so the
  // bubbles' memo holds.
  const jumpToQuestion = useCallback((questionId: string) => {
    const line = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-slot="ask-line"]') ?? [])]
      .find((el) => el.dataset.questionId === questionId);
    if (!line) return;
    const key = askOpenKey(questionId);
    setExpandedToolIds((current) => (current.has(key) ? current : new Set(current).add(key)));
    // Its head: a line open taller than the screen, centred whole, would put
    // its head and the question's start above the view.
    (line.querySelector<HTMLElement>('[data-slot="ask-line-head"]') ?? line).scrollIntoView({ block: "center", behavior: "instant" });
    line.removeAttribute("data-question-flash");
    // A reflow, so flashing the same line again restarts the animation.
    void line.offsetWidth;
    line.setAttribute("data-question-flash", "");
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => line.removeAttribute("data-question-flash"), QUESTION_FLASH_MS);
  }, [scrollRef]);
  const windowedItems = useMemo(
    () => (renderItems.length > renderWindow ? renderItems.slice(-renderWindow) : renderItems),
    [renderItems, renderWindow]
  );
  // Tool-only steps join the step before them, so a stretch of tool work reads
  // as one line. After windowing: a run cut by the window starts where it is cut.
  const groupedItems = useMemo(() => groupToolRuns(windowedItems), [windowedItems]);
  // Where the divider pass stands at the window's first row: the rows above it
  // are not drawn yet, but they decide whether that row opens a day or a pause.
  const dividerSeed = useMemo(() => dividerSeedFor(renderItems, windowedItems.length), [renderItems, windowedItems.length]);
  // Each watch firing, alarm or analyzer event joined to the reply its wake
  // produced: one cause line over that reply rather than an event row and then
  // a reply (see pairWakeCauses).
  const causedItems = useMemo(
    () => pairWakeCauses(groupedItems, (m) => wakeReasonOf(m, thread.wakeReasonsById)),
    [groupedItems, thread.wakeReasonsById]
  );
  // The run the running turn is on names its latest call, until the turn
  // writes or ends.
  const replyStreaming = thread.streamingAssistant !== null && thread.streamingAssistant.wakeId === activeWakeId && thread.streamingAssistant.totalText !== "";
  const liveRun = useMemo(() => liveRunRow(causedItems, activeWakeId, replyStreaming), [causedItems, activeWakeId, replyStreaming]);
  const workedFor = useMemo(() => workedForByWake(thread.messages, activeWakeId), [thread.messages, activeWakeId]);
  const datedWindowedItems = useMemo(() => datedRows(causedItems, dividerSeed), [causedItems, dividerSeed]);
  // The global agent's handoff cards, each under what its turn said about it.
  const handoffPlaces = useMemo(
    () => turnHandoffs(causedItems, toolResultsByCallId, streamingWakeId),
    [causedItems, toolResultsByCallId, streamingWakeId]
  );
  // How each turn that said nothing ends: the sentence it closed with, the
  // plain fact that it finished, or that it was interrupted (turnEndings).
  const endings = useMemo(() => turnEndings(causedItems, {
    loaded: renderItems,
    loadedFrom,
    turnStarts,
    liveWakeIds,
    interruptedWakeIds,
    results: toolResultsByCallId,
    draws: (row) => rowDrawsWork(row, toolResultsByCallId, handoffPlaces.byRow.get(row)),
    reasonOf
  }), [causedItems, renderItems, loadedFrom, turnStarts, liveWakeIds, interruptedWakeIds, toolResultsByCallId, handoffPlaces, reasonOf]);
  const endingCalls = useMemo(() => callsShownAsEndings(endings), [endings]);
  const actionsByRow = useMemo(() => rowActions(causedItems, {
    loaded: renderItems,
    loadedFrom,
    turnStarts,
    activeWakeId,
    workedFor,
    endings,
    isUserBubble
  }), [causedItems, renderItems, loadedFrom, turnStarts, activeWakeId, workedFor, endings]);
  // A watch names its pane as this thread named it (tool-details/names.ts).
  const watchPane = useCallback((watchId: string) => toolNames.watchPanes.get(watchId) ?? null, [toolNames]);
  // A notice to the global agent names a worker by where its chat is.
  const workerHref = useWorkerChatHrefs();

  // Open runs are their conversation's: another one opens with none. Only on
  // a real switch, not on mount.
  const resetForThreadRef = useRef(thread.threadId);
  useEffect(() => {
    if (resetForThreadRef.current === thread.threadId) return;
    resetForThreadRef.current = thread.threadId;
    setExpandedToolIds(new Set());
  }, [thread.threadId]);

  const handleToolExpandedChange = useCallback((toolCallId: string, expanded: boolean) => {
    setExpandedToolIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(toolCallId);
      else next.delete(toolCallId);
      return next;
    });
  }, []);

  const renderedWakeProvenanceIds = new Set<string>();

  /** One transcript row. */
  function renderTranscriptItem(item: TranscriptRow): ReactNode {
    if (item.kind === "pending") {
      return (
        <UserMessage
          key={item.pending.localId}
          text={item.pending.content}
          attachments={item.pending.attachments ?? []}
          status={item.pending.status}
          error={item.pending.error}
          answers={item.pending.answers}
          mentions={item.pending.mentions}
          jumpable={item.pending.answers ? askedHere : undefined}
          onJumpToQuestion={jumpToQuestion}
          onRetry={
            item.pending.status === "failed" && onRetryFailed
              ? () => onRetryFailed(item.pending.localId)
              : undefined
          }
        />
      );
    }
    const m = item.message;
    // Compression summaries are stored with role:"user" (not "system") so the LLM
    // never sees a mid-conversation system message. Render them with the same
    // visual treatment as other system events though, since they're not user input.
    if (m.role === "user" && m.source === "compression") {
      return m.content.type === "summary" ? <CompressionSummaryMessage key={m.id} message={m} /> : null;
    }
    if (m.role === "user" && m.source === "restart-recovery") {
      return (
        <ContextBoundary key={m.id}>
          Mandate restarted · resumed the interrupted turn
        </ContextBoundary>
      );
    }
    if (m.role === "user" && m.source === "project-change") {
      const change = projectChangeOf(m.content);
      return change ? (
        <ContextBoundary key={m.id} title={`${change.projectName}: ${change.from} → ${change.to}`}>
          Working directory changed to <span className="font-mono">{change.to}</span>
        </ContextBoundary>
      ) : null;
    }
    if (m.content.type === "wake_failure") {
      return <WakeFailureLine key={m.id} failure={m.content} at={m.createdAt} action={failureAction(m)} />;
    }
    if (rendersNothing(item)) return null;
    // A trigger whose wake has not answered (or said nothing): its cause line alone.
    if (triggerReason(m)) {
      const cause = causeForTriggerMessage(m, watchPane, workerHref);
      return cause ? <ChatProvenanceLine key={m.id} provenance={cause} /> : null;
    }
    if (m.role === "user" && m.source === "worker-report") {
      const report = workerReportOf(m.content);
      return report ? <WorkerReportCard key={m.id} report={report} onOpen={onOpenWorker} /> : null;
    }
    if (m.role === "user" && m.source === "subagent-result") {
      const result = subagentResultOf(m);
      return result ? <SubagentResultCard key={m.id} result={result} /> : null;
    }
    if (m.role === "user" && m.source === "command-result") {
      const result = commandResultOf(m);
      return result ? <CommandResultLine key={m.id} result={result} /> : null;
    }
    if (m.role === "user" && m.source === "feature-message") {
      return <FeatureMessageLine key={m.id} message={m} named={nameReplies} />;
    }
    if (m.role === "user") {
      // In a worker's chat the manager's messages are drawn on the user's
      // side, as whoever asks is; they say whose they are, and a long one
      // is folded until opened.
      const foldKey = foldsWhenLong(m) ? foldOpenKey(m.id) : undefined;
      return (
        <UserTextMessage
          key={m.id}
          message={m}
          agentName={agentName}
          sender={m.source === "manager" ? "Manager" : undefined}
          foldKey={foldKey}
          foldOpen={foldKey !== undefined && expandedToolIds.has(foldKey)}
          onFoldChange={handleToolExpandedChange}
          askedHere={askedHere}
          onJumpToQuestion={jumpToQuestion}
        />
      );
    }
    if (m.role === "assistant") {
      const wakeMetadata = m.wakeMetadata ??
        (m.wakeId ? (thread.wakeMetadataById.get(m.wakeId) ?? null) : null);
      const provenance: ChatProvenance | null = item.cause
        ? causeForTriggerMessage(item.cause, watchPane, workerHref)
        : provenanceForWake(
            wakeReasonOf(m, thread.wakeReasonsById),
            { wakeId: m.wakeId, createdAt: m.createdAt, metadata: wakeMetadata }
          );
      const showProvenance = provenance && (!m.wakeId || !renderedWakeProvenanceIds.has(m.wakeId));
      if (showProvenance && m.wakeId) renderedWakeProvenanceIds.add(m.wakeId);
      const assistant = (
        <AssistantMessage
          message={m}
          runTail={item.runTail}
          toolResultsByCallId={toolResultsByCallId}
          activeToolCallId={runningCallId}
          liveRun={item === liveRun}
          expandedToolIds={expandedToolIds}
          onToolExpandedChange={handleToolExpandedChange}
          handoffs={handoffPlaces.byRow.get(item)}
          closing={closingOf(endings.get(item))}
          callsShownElsewhere={endingCalls}
          questions={questionMarks}
          voiceMarker={m.source === "voice"}
        />
      );
      return showProvenance ? (
        <AssistantReplyGroup key={m.id} provenance={provenance}>
          {assistant}
        </AssistantReplyGroup>
      ) : (
        <Fragment key={m.id}>{assistant}</Fragment>
      );
    }
    return null;
  }

  // The rows as drawn, and what each is for telling what arrived (the
  // streamed reply is one too): those that arrive rise into place.
  const shownRows: ShownRow[] = [];
  const transcriptRows = datedWindowedItems.map((entry) => {
    if (entry.kind === "date") {
      return (
        <ChatDateSeparator
          key={`date-${entry.key}`}
          timestamp={entry.timestamp}
          label={entry.label}
        />
      );
    }
    const drawn = renderTranscriptItem(entry.item);
    if (!drawn) return null;
    const key = rowKeyOf(entry.item);
    shownRows.push(shownRowOf(entry.item, key));
    const actions = actionsByRow.get(entry.item) ?? null;
    const at = rowTimeOf(entry.item, isUserBubble(entry.item));
    return <RowFrame key={key} rowKey={key} at={at} actions={actions}>{drawn}</RowFrame>;
  });
  const streamingWake = thread.streamingAssistant?.wakeId ?? null;
  if (streamingWake !== null) shownRows.push({ key: `streaming-${streamingWake}`, kind: "stream", wakeId: streamingWake });
  useArrivingRows(columnRef, {
    threadId: thread.threadId,
    rows: shownRows,
    newestSeq: thread.messages.reduce((newest, m) => Math.max(newest, m.seq), 0),
    pending: thread.pendingUserMessages,
    streamedWords: streamingWake !== null && streamingText !== "" ? streamingWake : null,
    voiceWords: { user: Boolean(inProgressLines?.user?.text), assistant: Boolean(inProgressLines?.assistant?.text) }
  });

  return (
    /* Container context for the transcript's narrow-width rules. Deliberately
       on this wrapper and not on the scroller below: `@container` implies
       `contain: layout inline-size`, and the scroller owns scroll position and
       stick-to-bottom. Same inline size, none of the risk. */
    <ToolNamesContext.Provider value={toolNames}>
    <PendingMonitorsContext.Provider value={pendingMonitorIds}>
    {/* Clips: pressed to nothing by what stands above the composer on a
        short screen, the scroller's own padding would otherwise lie over it. */}
    <div className="@container relative flex-1 min-h-0 min-w-0 overflow-hidden">
      {/* `overflow-anchor:none` is a deliberate trade, not a cleanup. Read both
          halves before touching it.

          WHAT IT BUYS. The browser otherwise shifts scrollTop during any reflow
          to hold the content you were looking at steady, and fires a scroll
          event for a scroll the user never made. Rows reflow when the pane is
          resized (an open tool run's arguments and output most of all); when
          following went by distance from the end, one such phantom scroll
          read as "scrolled away" and the transcript silently stopped
          following, on nothing but a dock resize. Following goes by
          the reader's own scroll now (transcript-scroll.ts), and that reading
          relies on scrollTop moving only when the reader or this code moves it.

          WHAT IT COSTS. Content that grows ABOVE a scrolled-up reader is no
          longer compensated, so what they are reading can shift under them.
          Older messages are covered: useTranscriptViewport measures and
          restores the reader's place as they land. A late-loading image is
          NOT covered: a reader who has scrolled up above it will see the
          content move. (The markdown pipeline is loaded with the chat, not
          lazily, so replies paint formatted in their first frame — a lazy
          chunk reflowed every reply ~300ms after each refresh;
          e2e/chat-refresh-stable.test.ts.)

          DO NOT restore `overflow-anchor: auto` to fix that shifting. The fix,
          if it is ever worth making, is to compensate by hand the way older
          messages are: note where the reader is and restore it. */}
      {/* fade-y-edges: text scrolling past the top or bottom fades over the
          16px of py-4 instead of being cut mid-line; at rest at either end
          that is padding, so nothing shown fades. Keep the two equal. */}
      <div
        ref={scrollRef}
        className={`fade-y-edges h-full min-w-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none] [scrollbar-gutter:stable] ${CHAT_GUTTER_CLASS} px-(--chat-gutter) py-4 flex flex-col gap-4`}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        <div
          ref={columnRef}
          data-slot="transcript-column"
          data-filling={filling || undefined}
          className={cn("mx-auto flex w-full flex-col gap-4", filling && "[&>*:not([data-slot=older-slot])]:invisible")}
          style={{ maxWidth: CHAT_COLUMN_MAX_PX }}
        >
          {thread.hasMoreOlder && olderError !== null && (
            <InlineError className="mb-1" detail={olderError} onRetry={retryOlder}>
              Couldn't load older messages.
            </InlineError>
          )}
          {/* One line's height while there is more, the loading line in it
              while a page loads: its coming and going moves nothing below.
              It goes with the last page, in that page's commit. */}
          {thread.hasMoreOlder && olderError === null && (
            <div data-slot="older-slot" className="h-5 shrink-0">{loadingOlder && <LoadingLine />}</div>
          )}

          {renderItems.length === 0 && hiddenQueuedCount === 0 && !thread.streamingAssistant && (emptyState ?? (
            <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-3">
              <p className="font-medium text-foreground">No messages yet</p>
              {emptyHelp && (
                <p className="mt-2 text-xs">
                  The agent has access to bash, file editing, and your tmux panes.
                </p>
              )}
              {emptyHelp === "worker" && (
                <p className="mt-2 text-xs italic">
                  Try:{" "}
                  <span className="font-mono not-italic">
                    "what's running in your panes right now?"
                  </span>
                </p>
              )}
            </div>
          ))}

          {transcriptRows}

          {thread.streamingAssistant
            ? (() => {
                const wakeId = thread.streamingAssistant.wakeId;
                const provenance = renderedWakeProvenanceIds.has(wakeId)
                  ? null
                  : provenanceForWake(thread.wakeReasonsById.get(wakeId) ?? null, {
                      wakeId,
                      metadata: thread.wakeMetadataById.get(wakeId) ?? null
                    });
                if (provenance) renderedWakeProvenanceIds.add(wakeId);
                // The turn's handoff cards follow what it has written so far,
                // spaced as they will be in its row once the words are stored.
                // Its words carry its key as a row (arriving-rows): they rise
                // as they start, not the cards already shown after them.
                const streamingKey = `streaming-${wakeId}`;
                const streaming = handoffPlaces.trailing.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    <StreamingAssistantMessage text={streamingText} rowKey={streamingKey} />
                    <div className="flex flex-col gap-1.5">
                      {handoffPlaces.trailing.map((h) => (
                        <HandoffCard key={h.id} handoffId={h.id} fallback={h.dto} expandedIds={expandedToolIds} onExpandedChange={handleToolExpandedChange} />
                      ))}
                    </div>
                  </div>
                ) : <StreamingAssistantMessage text={streamingText} rowKey={streamingKey} />;
                return provenance ? (
                  <AssistantReplyGroup key={streamingKey} provenance={provenance}>
                    {streaming}
                  </AssistantReplyGroup>
                ) : (
                  <Fragment key={streamingKey}>{streaming}</Fragment>
                );
              })()
            : null}

          {inProgressLines?.user && (
            <UserMessage
              key="voice-in-progress-user"
              text={inProgressLines.user.text}
              status="persisted"
              voiceMarker
              ephemeral
            />
          )}
          {inProgressLines?.assistant && (
            <EphemeralAssistantBubble
              key="voice-in-progress-assistant"
              text={inProgressLines.assistant.text}
            />
          )}

          <WorkingIndicator line={working} />
          {!turnRunning && waiting.length > 0 && <WaitingLines lines={waiting} />}

        </div>
      </div>

      {showLatest && (
        <Button
          variant="outline"
          size="icon"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 h-9 w-9 rounded-full shadow-md bg-panel"
          aria-label="Scroll to latest message"
          onClick={scrollToLatest}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}
    </div>
    </PendingMonitorsContext.Provider>
    </ToolNamesContext.Provider>
  );
}

/** A person's message. */
function UserTextMessage({ message: m, agentName, sender, foldKey, foldOpen, onFoldChange, askedHere, onJumpToQuestion }: {
  message: AgentMessage;
  agentName: string;
  sender?: string;
  foldKey?: string;
  foldOpen?: boolean;
  onFoldChange?: (key: string, open: boolean) => void;
  askedHere: ReadonlySet<string>;
  onJumpToQuestion: (questionId: string) => void;
}) {
  // One list per message, so the bubble's memo holds while a reply streams.
  const answers = useMemo(() => answersOf(m.content), [m.content]);
  const mentions = useMemo(() => mentionsOf(m.content), [m.content]);
  const text = m.content.type === "text" ? m.content.text : "";
  const attachments = m.content.type === "text" ? (m.content.attachments ?? []) : [];
  return (
    <UserMessage
      text={text}
      attachments={attachments}
      status="persisted"
      voiceMarker={m.source === "voice"}
      relayLabel={relayLabelOf(m, agentName)}
      sender={sender}
      foldKey={foldKey}
      foldOpen={foldOpen}
      onFoldChange={onFoldChange}
      {...(answers.length > 0 ? { answers, jumpable: askedHere, onJumpToQuestion } : {})}
      {...(mentions.length > 0 ? { mentions } : {})}
    />
  );
}

/** "via <name>" under a message the global agent sent for the user, "· Voice"
 *  when it was spoken. */
function relayLabelOf(m: AgentMessage, agentName: string): string | undefined {
  const relay = m.content.type === "text" ? m.content.relay : undefined;
  if (!relay) return undefined;
  return relay.spoken ? `via ${agentName} · Voice` : `via ${agentName}`;
}

/** When the newest message this page is sending (or sent, queued or failed)
 *  was written, null with none: the last one added, as the store keeps them
 *  in the order they were sent. A message settled into the transcript
 *  leaves the older ones. */
function newestSentAt(pending: ReadonlyMap<string, { createdAt: string }>): string | null {
  let newest: string | null = null;
  for (const message of pending.values()) newest = message.createdAt;
  return newest;
}
