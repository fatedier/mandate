import { taskCommentOf, taskReminderOf } from "@shared/task-board";
import { TaskReminderLine } from "@/routes/task-board/TaskReminderLine";
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import { useAgentChatStore, type AgentMessage, type ThreadState } from "@/store/agent-chat";
import { WakeFailureLine } from "./WakeFailureLine";
import { actionableFailureId } from "./failure-action";
import { Button } from "@/components/ui/button";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { cn } from "@/lib/utils";
import { ArrowDown, ArrowUp } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { useReasoningHeadingStore } from "@/store/reasoning-heading";
import { useReplyActivityStore } from "@/store/reply-activity";
import { useInterruptedWakesStore } from "@/store/interrupted-wakes";
import { useThreadTasksById } from "@/store/background-tasks";
import { AssistantMessage } from "./AssistantMessage";
import { answeredQuestions, askOpenKey, openAskPausesFollow, skippedQuestions, withdrawnQuestions } from "./ask-lines";
import { StreamingAssistantMessage } from "./StreamingAssistantMessage";
import { WorkingIndicator } from "./WorkingIndicator";
import { workingLine } from "./working-line";
import { workedForByWake } from "./worked-for";
import { callsShownAsEndings, rowDrawsWork, turnEndings, type TurnEnding } from "./turn-endings";
import { CompressionSummaryMessage } from "./CompressionSummaryMessage";
import { WorkerMessageLine } from "./WorkerMessageLine";
import { handoffsCalledBy, useWorkerChatHrefs } from "@/routes/personal/handoff-tools";
import { WorkerReportCard } from "./WorkerReportCard";
import { SubagentResultCard } from "./SubagentResultCard";
import { CommandResultLine } from "./CommandResultLine";
import { commandResultOf, openEndedPausesFollow, startedTask, subagentResultOf } from "./subagent-lines";
import { workerReportOf } from "@shared/worker-report";
import { projectChangeOf } from "@shared/project-change";
import { formatCalendarDate } from "@/lib/format";
import { answersOf, askedOf } from "@shared/questions";
import { pageQuotesOf } from "@shared/page-quotes";
import { mentionsOf } from "@shared/mentions";
import { ChatProvenanceLine } from "./ChatProvenanceLine";
import { NoticeRunHeader, NoticeRunMember } from "./NoticeRunLine";
import { noticeRunKeys, noticeRunOpenKey, noticeRuns, noticesInRuns, openNoticeRunPausesFollow } from "./notice-runs";
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
import { datedRows, dividerSeedFor, foldOpenKey, foldsWhenLong, liveRunRow, openFoldPausesFollow, openRunPausesFollow, rendersNothing, sideChatSummaryOpenKey, transcriptItems, wakeReasonOf, type TranscriptRow } from "./transcript-rows";
import { rowActions, unansweredOwnMessages } from "./row-actions";
import { AssistantReplyGroup, ChatDateSeparator, EphemeralAssistantBubble, NewRepliesLine, RowFrame } from "./TranscriptRowFrame";
import { reachesBack, readSince, useSeenNewLines } from "./new-replies";
import { SideChatSummaryCard } from "./SideChatSummaryCard";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useThreadWorkers } from "@/hooks/useThreadWorkers";
import { workerMessageMetadata } from "@shared/worker-message";
import { personalAgentLabel } from "@/lib/personal-agent-label";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { displayPersonalAgentName } from "@shared/personal-agent-name";
import { CHAT_COLUMN_MAX_PX, CHAT_GUTTER_CLASS } from "./chat-column";
import { useTranscriptViewport, type ApplyOlder, type TranscriptPlace } from "./useTranscriptViewport";
import { useArrivingRows, type ShownRow } from "./arriving-rows";
import { ShareBeginContext, ShareSelectionContext } from "./share-selection-state";
import { pickedRuns, shareableRows, shareKeyOf, shareText } from "./share-selection";
import { ShareRow } from "./ShareRow";

/** How long a question's line flashes when an answer's quote leads to it. */
const QUESTION_FLASH_MS = 1400;

/** Rows that are not the user's own words, though the server stores them as
 *  the user's: each is drawn as something else (renderTranscriptItem). */
const NOT_THE_USERS_WORDS = new Set(["compression", "restart-recovery", "worker-report", "worker-message", "thread-notice", "project-change", "subagent-result", "command-result", "page-input", "page-result", "side-chat-boundary", "task-reminder"]);

/** A side chat's first own row: where it started, drawn as a line. */
const isSideChatStart = (item: TranscriptRow) => item.kind === "msg" && item.message.source === "side-chat-boundary";

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
const NO_ROWS: readonly TranscriptRow[] = [];

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
   *  an example question about its worker. Null, none. */
  emptyHelp?: "worker" | "manager" | null;
  /** Shown instead of "No messages yet" (and its help). */
  emptyState?: ReactNode;
  /** Ephemeral in-progress voice transcripts to render at the bottom.
   *  Keyed by speaker; null when no streaming for that speaker. */
  inProgressLines?: { user: VoiceTranscriptLine | null; assistant: VoiceTranscriptLine | null };
  /** Opens a worker from its report card. */
  onOpenWorker?: (workerId: string) => void;
  /** The conversation's open questions, by id: the line where one was asked
   *  says whether it still waits. Absent, each reads as answered. */
  openQuestionIds?: ReadonlySet<string>;
  /** "history": a second, read-only view of the conversation (the personal agent's
   *  History tab). A send made in the chat does not move it. */
  view?: "chat" | "history";
  /** Opens at this place rather than at the end. */
  startAt?: TranscriptPlace | null;
  /** Told where the reader is as they scroll: null at the end. */
  onPlace?: (place: TranscriptPlace | null) => void;
  /** Hands the page a way to read beside (the personal agent's History button):
   *  while the reader is scrolled up it takes the row at the top of the view
   *  and the chat goes back to its latest; at the end it takes nothing. Null
   *  once the list is gone. */
  offerReadBeside?: (take: (() => TranscriptPlace | null) | null) => void;
  /** The conversation's key in the chat store: while the reader is not kept
   *  at the end, its loaded messages are held whole. The store drops the
   *  oldest as new ones come, and dropped above a reader who scrolled up they
   *  moved what the reader was on (the scroller does not anchor). */
  holdKey?: string;
  /** Where the user had read to when they came back (the page's read
   *  point): a line marks what came after it, and while the line is above
   *  the view a bar says how many replies are new and goes to it. Null or
   *  absent, none. */
  newSince?: number | null;
}

const STREAMING_RENDER_INTERVAL_MS = 80;
/** Pages loaded at most to reach the read point: what came since may be
 *  long, and then the line waits for the reader to scroll up to it. */
const READ_POINT_PAGES = 5;

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
  view = "chat",
  startAt = null,
  onPlace,
  offerReadBeside,
  holdKey,
  newSince = null
}: ChatMessageListProps) {
  // Relayed messages say who passed them on: the personal agent, by its name.
  const agentName = usePersonalAgentStore((s) => displayPersonalAgentName(s.agent?.name ?? ""));
  // Who a duty thread's reports go to, as the page calls it.
  const reportTo = usePersonalAgentStore((s) => personalAgentLabel(s.agent));
  const liveMarks = useAgentChatStore((s) => s.dutyMarks);
  // A reply sent as the report, or kept back: its mark (other outcomes have none).
  const dutyMarkProp = (m: AgentMessage) => {
    const outcome = m.dutyReport ?? liveMarks.get(m.id);
    return outcome === "sent" || outcome === "no_report" ? { dutyMark: { outcome, to: reportTo } } : {};
  };
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
  // A step that sent something the personal agent hands off ends its run: its
  // card is drawn under the work that sent it, and the work after is a line
  // of its own below the card (groupToolRuns).
  const sentCard = useCallback((step: AgentMessage) => handoffsCalledBy([step], toolResultsByCallId).length > 0, [toolResultsByCallId]);
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
    const ids = new Set(threadWorkers.map((w) => w.workerId));
    for (const m of thread.messages) {
      if (m.source !== "worker-message") continue;
      const id = workerMessageMetadata(m.content)?.workerId;
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

  // What the thread called its panes and workers, for the tool calls that
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
    () => expandedToolIds.size === 0 ? NO_CALLS : callsShownAsEndings(turnEndings(groupToolRuns(renderItems, sentCard), {
      loaded: renderItems, loadedFrom, turnStarts, liveWakeIds, interruptedWakeIds, results: toolResultsByCallId, draws: () => true, reasonOf
    })),
    [expandedToolIds, renderItems, loadedFrom, turnStarts, liveWakeIds, interruptedWakeIds, toolResultsByCallId, reasonOf, sentCard]
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
  // What the tasks the rows started stand at: an ended commands' line is
  // drawn only once two or more of a row's commands have ended.
  const threadTasks = useThreadTasksById(thread.threadId);
  // Picking messages to share (the conversation's): the transcript shows only
  // what can be shared, and holds still while it does.
  const share = useContext(ShareSelectionContext);
  const selecting = share?.selecting ?? false;
  const since = useMemo(
    () => (newSince === null ? null : readSince(thread.messages, newSince, [...thread.pendingUserMessages.values()].filter((p) => p.status !== "failed").length)),
    [newSince, thread.messages, thread.pendingUserMessages]
  );
  const reached = newSince === null || reachesBack(thread.messages, newSince, thread.hasMoreOlder);
  const fresh = since !== null && reached && !since.wrote && since.count > 0 && since.firstSeq !== null
    ? { count: since.count, firstSeq: since.firstSeq }
    : null;
  // The notices in a run, over every loaded row as the list draws them (its
  // render window aside): an open one pauses following, as an open fold does.
  const freshFrom = fresh?.firstSeq ?? null;
  const noticesInDrawnRuns = useMemo(() => {
    const grouped = groupToolRuns(renderItems, sentCard, freshFrom !== null ? newSince : null);
    const paired = pairWakeCauses(grouped, (m) => wakeReasonOf(m, thread.wakeReasonsById));
    return noticesInRuns(datedRows(paired, dividerSeedFor(renderItems, renderItems.length)), freshFrom);
  }, [renderItems, sentCard, freshFrom, newSince, thread.wakeReasonsById]);
  const expansionPausesFollow = useMemo(
    () => openRunPausesFollow(renderItems, expandedToolIds, isMobile, drawnOutOfRuns) || openFoldPausesFollow(renderItems, expandedToolIds) ||
      openNoticeRunPausesFollow(noticesInDrawnRuns, expandedToolIds) ||
      openAskPausesFollow(renderItems, toolResultsByCallId, expandedToolIds, openQuestionIds) ||
      openEndedPausesFollow(renderItems, toolResultsByCallId, expandedToolIds, threadTasks, sentCard),
    [isMobile, expandedToolIds, renderItems, toolResultsByCallId, drawnOutOfRuns, openQuestionIds, threadTasks, sentCard, noticesInDrawnRuns]
  );
  const columnRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const {
    scrollRef, onScroll, onWheel, onTouchStart, onTouchMove, onTouchEnd, renderWindow,
    showLatest, pinned, followingNow, scrollToLatest, currentPlace, loadingOlder, olderError, retryOlder, loadOlderPage, filling
  } = useTranscriptViewport({
    threadId: thread.threadId,
    itemCount: renderItems.length,
    hasMoreOlder: thread.hasMoreOlder,
    loadOlder: onLoadOlder,
    followPaused: expansionPausesFollow || selecting,
    // When the newest message this page sent was written: a send of the
    // reader's own takes them to the end, in the chat it was sent from.
    sentAt: view === "history" ? null : newestSentAt(thread.pendingUserMessages),
    startAt,
    ...(onPlace ? { onPlace } : {}),
    // The newest row by key, not by count: once the cache holds its 500, a
    // new message pushes the oldest out and the count stays.
    growthKey: [renderItems.length > 0 ? rowKeyOf(renderItems[renderItems.length - 1]!) : "", streamingText, bottomEphemeralKey].join("\u0001")
  });
  // Held from the commit that leaves the end, before a message can come.
  // What came after the read point, once the loaded messages reach back to
  // it; until then older pages load, a few at most.
  // A message that failed to send went nowhere: no word of the user's.
  const lineShown = fresh !== null;
  // Hidden in a page kept while another shows (shell/KeptPage), the reader's
  // rows stay held until it shows again, or messages coming meanwhile would
  // trim them away: its cleanup runs then as on removal, so it lets go only
  // once the commit is over and the list has left the document, or another
  // hold has taken its place.
  const holdWhole = useAgentChatStore((s) => s.holdWhole);
  const holdsRef = useRef<{ round: number; kept: (() => void) | null }>({ round: 0, kept: null });
  useLayoutEffect(() => {
    const holds = holdsRef.current;
    const round = ++holds.round;
    const kept = holds.kept;
    holds.kept = null;
    // Kept at the newest the rows need no hold, unless the line marking what
    // is new stands among them: the oldest going as new ones come would take
    // it away from a reader who has not read on to it.
    if (!holdKey || (pinned && !lineShown)) {
      kept?.();
      return;
    }
    const release = holdWhole(holdKey);
    kept?.();
    const list = scrollRef.current;
    // Taken only for the line: it goes when the reader leaves, the page
    // hidden or not (the line goes with the reader).
    const forLine = pinned;
    return () => {
      queueMicrotask(() => {
        if (!forLine && holds.round === round && list?.isConnected) holds.kept = release;
        else release();
      });
    };
  }, [holdKey, pinned, lineShown, holdWhole, scrollRef]);
  // Read beside, for the page that asks: what the reader is at when it is
  // asked, never what it was at when this rendered.
  const readerAt = useRef({ showLatest, currentPlace, scrollToLatest, followingNow, expansionPausesFollow });
  useLayoutEffect(() => { readerAt.current = { showLatest, currentPlace, scrollToLatest, followingNow, expansionPausesFollow }; });
  useEffect(() => {
    if (!offerReadBeside) return;
    offerReadBeside(() => {
      const now = readerAt.current;
      if (!now.showLatest) return null;
      const place = now.currentPlace();
      now.scrollToLatest();
      return place;
    });
    return () => offerReadBeside(null);
  }, [offerReadBeside]);
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
  const pagesForPoint = useRef({ key: "", asked: 0 });
  useEffect(() => {
    if (newSince === null || reached || since === null || since.wrote) return;
    const key = `${thread.threadId}:${newSince}`;
    if (pagesForPoint.current.key !== key) pagesForPoint.current = { key, asked: 0 };
    if (pagesForPoint.current.asked >= READ_POINT_PAGES) return;
    if (loadOlderPage()) pagesForPoint.current.asked += 1;
  });
  const [newLine, setNewLine] = useState<HTMLDivElement | null>(null);
  const [lineAbove, setLineAbove] = useState(false);
  // The visit whose line has been in view (gone to by the bar, or scrolled up
  // to by hand): the bar does not come back for it as the reader reads on.
  // Only the line at its place counts: a long conversation draws its last
  // rows first, the line for a moment above them, not yet where it belongs.
  const lineVisit = `${thread.threadId}:${newSince}`;
  const lineSeen = useSeenNewLines((s) => s.seen.has(lineVisit));
  const firstDrawnSeq = windowedItems.find((item) => item.kind === "msg")?.message.seq ?? null;
  const linePlaced = windowedItems.length === renderItems.length || (fresh !== null && firstDrawnSeq !== null && firstDrawnSeq < fresh.firstSeq);
  // Above the view: gone past the top, not below it (a reader scrolled up).
  // The observer tells when the line crosses the view's edge; a scrollbar
  // drag or Home and End move it from one side to the other without
  // crossing, so each scroll is measured too.
  useEffect(() => {
    const root = scrollRef.current;
    if (!newLine || !root) return;
    const measure = () => {
      const line = newLine.getBoundingClientRect();
      const view = root.getBoundingClientRect();
      setLineAbove(line.bottom <= view.top);
      if (linePlaced && line.bottom > view.top && line.top < view.bottom) useSeenNewLines.getState().mark(lineVisit);
    };
    root.addEventListener("scroll", measure, { passive: true });
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (!entry) return;
      setLineAbove(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
      if (linePlaced && entry.isIntersecting) useSeenNewLines.getState().mark(lineVisit);
    }, { root });
    observer?.observe(newLine);
    return () => {
      root.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [newLine, scrollRef, lineVisit, linePlaced]);
  // At once, as a question's line is gone to: the scroll has left the end,
  // so following the end does not take the reader back down.
  // Seen is told by the measure once the line is in view, after the scroll:
  // the bar's room going in this commit would shorten the content under a
  // scroll still to come, and the reader would read as still at the end.
  const jumpToNew = useCallback(() => { newLine?.scrollIntoView({ block: "start", behavior: "instant" }); }, [newLine]);
  // Tool-only steps join the step before them, so a stretch of tool work reads
  // as one line. After windowing: a run cut by the window starts where it is cut.
  // A run read up to the point ends there, so the line can stand above what came after.
  const splitAt = fresh !== null ? newSince : null;
  const groupedItems = useMemo(() => groupToolRuns(windowedItems, sentCard, splitAt), [windowedItems, sentCard, splitAt]);
  // Where the divider pass stands at the window's first row: the rows above it
  // are not drawn yet, but they decide whether that row opens a day or a pause.
  const dividerSeed = useMemo(() => dividerSeedFor(renderItems, windowedItems.length), [renderItems, windowedItems.length]);
  // Each monitor firing, alarm, notice or schedule joined to the reply its wake
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
  // Notices of one thread that came one after another: one line (NoticeRunLine).
  // Cut where the New line goes, as tool runs are.
  const noticeSplitAt = fresh?.firstSeq ?? null;
  const noticeRunsAt = useMemo(() => noticeRuns(datedWindowedItems, noticeSplitAt), [datedWindowedItems, noticeSplitAt]);
  // Each run's key, the one its notices had: its row stays the same row as
  // notices join it below or load above (focus, an open peek, the place).
  const [knownRunKeys, setKnownRunKeys] = useState<ReadonlyMap<string, string>>(() => new Map());
  const noticeRunKeysAt = useMemo(() => noticeRunKeys(datedWindowedItems, noticeRunsAt, knownRunKeys), [datedWindowedItems, noticeRunsAt, knownRunKeys]);
  useEffect(() => {
    let next: Map<string, string> | null = null;
    for (const [first, run] of noticeRunsAt) {
      const key = noticeRunKeysAt.get(first);
      if (key === undefined) continue;
      for (const i of run) {
        const entry = datedWindowedItems[i];
        const id = entry?.kind === "item" && entry.item.kind === "msg" ? entry.item.message.id : null;
        if (!id || (next ?? knownRunKeys).get(id) === key) continue;
        next ??= new Map(knownRunKeys);
        next.set(id, key);
      }
    }
    if (next) setKnownRunKeys(next);
  }, [noticeRunsAt, noticeRunKeysAt, datedWindowedItems, knownRunKeys]);
  // How each turn that said nothing ends: the sentence it closed with, the
  // plain fact that it finished, or that it was interrupted (turnEndings).
  const endings = useMemo(() => turnEndings(causedItems, {
    loaded: renderItems,
    loadedFrom,
    turnStarts,
    liveWakeIds,
    interruptedWakeIds,
    results: toolResultsByCallId,
    draws: (row) => rowDrawsWork(row, toolResultsByCallId),
    reasonOf
  }), [causedItems, renderItems, loadedFrom, turnStarts, liveWakeIds, interruptedWakeIds, toolResultsByCallId, reasonOf]);
  const endingCalls = useMemo(() => callsShownAsEndings(endings), [endings]);
  // Which of the owner's messages can be deleted: read over the stored
  // messages, as the server reads them, not the rows drawn.
  const unanswered = useMemo(() => unansweredOwnMessages(thread.messages, activeWakeId !== null), [thread.messages, activeWakeId]);
  const actionsByRow = useMemo(() => rowActions(causedItems, {
    loaded: renderItems,
    loadedFrom,
    turnStarts,
    activeWakeId,
    unanswered,
    workedFor,
    endings,
    isUserBubble
  }), [causedItems, renderItems, loadedFrom, turnStarts, activeWakeId, unanswered, workedFor, endings]);
  // What can be shared, told to the conversation that picks from it.
  const sharing = share !== null;
  const shareable = useMemo(
    () => (sharing ? shareableRows(causedItems, { isUserBubble, liveWakeIds }) : NO_ROWS),
    [sharing, causedItems, liveWakeIds]
  );
  const shareKeys = useMemo(() => new Set(shareable.map(shareKeyOf)), [shareable]);
  // Picked rows drawn one after another are one run (a divider parts two).
  const runs = useMemo(() => {
    if (!selecting || !share) return null;
    const drawn = datedWindowedItems.flatMap((entry) => {
      if (entry.kind === "date") return [null];
      const key = rowKeyOf(entry.item);
      return shareKeys.has(key) ? [key] : [];
    });
    return pickedRuns(drawn, share.selected);
  }, [selecting, share, datedWindowedItems, shareKeys]);
  useEffect(() => { share?.setRows(causedItems, shareable); }, [share, causedItems, shareable]);
  // Picking starts and ends with the reader where they were: the row picking
  // began at stays where it was on screen; on leaving, the top row in view
  // does, unless the view goes back to following the end (the reader is with
  // it, and no open run holds it).
  const shareAnchor = useRef<{ key: string; top: number } | null>(null);
  const rowTop = useCallback(
    (key: string) => columnRef.current?.querySelector<HTMLElement>(`[data-row-key="${key}"]`)?.getBoundingClientRect().top ?? null,
    []
  );
  const startPicking = share?.begin ?? null;
  const shareBegin = useMemo(() => {
    if (!startPicking) return null;
    return (key: string) => {
      const top = rowTop(key);
      shareAnchor.current = top === null ? null : { key, top };
      startPicking(key);
    };
  }, [startPicking, rowTop]);
  useEffect(() => {
    if (!share) return;
    share.onLeave(() => {
      shareAnchor.current = null;
      if (readerAt.current.followingNow() && !readerAt.current.expansionPausesFollow) return;
      const viewTop = scrollRef.current?.getBoundingClientRect().top ?? 0;
      const first = [...(columnRef.current?.querySelectorAll<HTMLElement>('[data-slot="share-row"]') ?? [])]
        .find((row) => row.getBoundingClientRect().bottom > viewTop);
      if (first?.dataset.rowKey) shareAnchor.current = { key: first.dataset.rowKey, top: first.getBoundingClientRect().top };
    });
    return () => share.onLeave(null);
  }, [share, scrollRef]);
  useLayoutEffect(() => {
    const anchor = shareAnchor.current;
    shareAnchor.current = null;
    const scroller = scrollRef.current;
    const top = anchor ? rowTop(anchor.key) : null;
    if (anchor && scroller && top !== null) scroller.scrollTop += top - anchor.top;
  }, [selecting, rowTop, scrollRef]);

  // A pane monitor names its pane as this thread named it (tool-details/names.ts).
  const monitoredPane = useCallback((monitorId: string) => toolNames.monitoredPanes.get(monitorId) ?? null, [toolNames]);
  // A notice to the personal agent names a worker by where its chat is.
  const workerHref = useWorkerChatHrefs();
  // Each trigger's cause line, read when the rows change, not on every
  // streamed delta (an alarm's formats its times), as the rows' own times are.
  const causes = useMemo(() => {
    const byId = new Map<string, ChatProvenance | null>();
    for (const item of causedItems) {
      if (item.kind !== "msg") continue;
      const trigger = item.cause ?? (triggerReason(item.message) ? item.message : null);
      if (trigger) byId.set(trigger.id, causeForTriggerMessage(trigger, monitoredPane, workerHref));
    }
    return byId;
  }, [causedItems, monitoredPane, workerHref]);
  const causeOf = (m: AgentMessage): ChatProvenance | null =>
    causes.has(m.id) ? causes.get(m.id) ?? null : causeForTriggerMessage(m, monitoredPane, workerHref);

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

  /** A run of notices: its line, in its first row's place, keyed by the run
   *  and timed by its latest. Open while any of its notices is marked open;
   *  opening or closing marks them all. */
  function noticeRunOf(run: readonly number[]): { items: Array<Extract<TranscriptRow, { kind: "msg" }>>; open: boolean; setOpen: (open: boolean) => void } {
    const items = run.flatMap((i) => {
      const entry = datedWindowedItems[i];
      return entry?.kind === "item" && entry.item.kind === "msg" ? [entry.item] : [];
    });
    const keys = items.map((item) => noticeRunOpenKey(item.message.id));
    return {
      items,
      open: keys.some((k) => expandedToolIds.has(k)),
      setOpen: (next) => setExpandedToolIds((current) => {
        const marks = new Set(current);
        for (const k of keys) {
          if (next) marks.add(k);
          else marks.delete(k);
        }
        return marks;
      })
    };
  }
  function renderNoticeRunHeader(run: readonly number[], runKey: string): ReactNode {
    const { items, open, setOpen } = noticeRunOf(run);
    const last = items.at(-1);
    const latest = last ? causeOf(last.message) : null;
    if (!last || !latest) return null;
    // Kept as the same row by the run's key; placed (a reader's place, what
    // arrived) by its latest notice, which another list of the thread finds.
    const place = rowKeyOf(last);
    shownRows.push(shownRowOf(last, place));
    return (
      <RowFrame key={`notice-run:${runKey}`} rowKey={place} holds={items.map(rowKeyOf)} at={last.message.createdAt} actions={null}>
        <NoticeRunHeader latest={latest} count={items.length} open={open} onOpenChange={setOpen} />
      </RowFrame>
    );
  }
  function renderNoticeRunMember(item: TranscriptRow): ReactNode {
    if (item.kind !== "msg") return null;
    const provenance = causeOf(item.message);
    if (!provenance) return null;
    const key = rowKeyOf(item);
    shownRows.push(shownRowOf(item, key));
    // No time of its own: close under the run's line, one would cover the
    // notice above it; the line has the latest's.
    return (
      <RowFrame key={key} rowKey={key} at={null} actions={null}>
        <NoticeRunMember provenance={provenance} />
      </RowFrame>
    );
  }

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
          pageQuotes={item.pending.pageQuotes}
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
    // A side chat's first own row is the model's; the user reads where it started.
    if (m.role === "user" && m.source === "side-chat-boundary") {
      return (
        <ContextBoundary key={m.id}>
          <span data-slot="side-chat-start">Started from {reportTo}'s conversation on {formatCalendarDate(m.createdAt)}. Thread updates don't come here.</span>
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
      const cause = causeOf(m);
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
      return result ? <CommandResultLine key={m.id} threadId={m.threadId} result={result} /> : null;
    }
    if (m.role === "user" && m.source === "worker-message") {
      return <WorkerMessageLine key={m.id} message={m} named={nameReplies} />;
    }
    // A task's @agent comment: the owner's words, the task under them; what
    // the model read with it is not drawn.
    const comment = m.role === "user" && m.source === "task-comment" && m.content.type === "text" ? taskCommentOf(m.content.metadata) : null;
    if (comment) {
      return <UserMessage key={m.id} text={comment.text} status="persisted" relayLabel="Task comment" task={{ id: comment.taskId, tooltip: "Open the task" }} />;
    }
    // The reminder the agent got about a task: a faint line.
    const reminder = m.role === "user" && m.source === "task-reminder" && m.content.type === "text" ? taskReminderOf(m.content.metadata) : null;
    if (reminder) return <TaskReminderLine key={m.id} reminder={reminder} agentName={agentName} />;
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
          summaryOpen={expandedToolIds.has(sideChatSummaryOpenKey(m.id))}
          askedHere={askedHere}
          onJumpToQuestion={jumpToQuestion}
        />
      );
    }
    if (m.role === "assistant") {
      const provenance: ChatProvenance | null = item.cause
        ? causeOf(item.cause)
        : provenanceForWake(wakeReasonOf(m, thread.wakeReasonsById));
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
          closing={closingOf(endings.get(item))}
          callsShownElsewhere={endingCalls}
          questions={questionMarks}
          voiceMarker={m.source === "voice"}
          {...dutyMarkProp(m)}
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
  // A run of notices is its line, in its first row's place, and while open
  // each notice under it a row of its own.
  const runOf = new Map<number, { first: number; run: readonly number[] }>();
  for (const [first, run] of noticeRunsAt) for (const i of run) runOf.set(i, { first, run });
  const firstNew = fresh !== null && !selecting
    ? datedWindowedItems.findIndex((entry) => entry.kind === "item" && entry.item.kind === "msg" && entry.item.message.seq >= fresh.firstSeq)
    : -1;
  const transcriptRows: ReactNode[] = [];
  datedWindowedItems.forEach((entry, index) => {
    if (index === firstNew) transcriptRows.push(<NewRepliesLine key="new-replies-line" ref={setNewLine} />);
    // A run's line and its first notice side by side, not nested: as older
    // notices load above, that notice stays the same row.
    const drawn = transcriptEntry(entry, index);
    if (Array.isArray(drawn)) transcriptRows.push(...drawn);
    else transcriptRows.push(drawn);
  });
  function transcriptEntry(entry: (typeof datedWindowedItems)[number], index: number): ReactNode | ReactNode[] {
    if (entry.kind === "date") {
      return (
        <ChatDateSeparator
          key={`date-${entry.key}`}
          timestamp={entry.timestamp}
          label={entry.label}
        />
      );
    }
    if (selecting) {
      // Every row counts as shown, drawn or not: picking ending is no arrival.
      const key = rowKeyOf(entry.item);
      shownRows.push(shownRowOf(entry.item, key));
      if (!share || !shareKeys.has(key)) return null;
      return (
        <ShareRow
          key={key}
          rowKey={key}
          side={isUserBubble(entry.item) ? "user" : "agent"}
          text={shareText(entry.item)}
          selected={share.selected.has(key)}
          joinedAbove={runs?.get(key)?.above ?? false}
          joinedBelow={runs?.get(key)?.below ?? false}
          onToggle={share.toggle}
        />
      );
    }
    const inRun = runOf.get(index);
    if (inRun) {
      const runKey = noticeRunKeysAt.get(inRun.first) ?? `${inRun.first}`;
      const open = noticeRunOf(inRun.run).open;
      const member = open ? renderNoticeRunMember(entry.item) : null;
      if (index !== inRun.first) return member;
      return [renderNoticeRunHeader(inRun.run, runKey), member];
    }
    const drawn = renderTranscriptItem(entry.item);
    if (!drawn) return null;
    const key = rowKeyOf(entry.item);
    shownRows.push(shownRowOf(entry.item, key));
    const actions = actionsByRow.get(entry.item) ?? null;
    const at = rowTimeOf(entry.item, isUserBubble(entry.item));
    return <RowFrame key={key} rowKey={key} at={at} actions={actions} shareable={shareKeys.has(key)}>{drawn}</RowFrame>;
  }
  const jumpShown = firstNew >= 0 && newLine !== null && lineAbove && !lineSeen;
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
    <ShareBeginContext.Provider value={shareBegin}>
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
          restores the reader's place as they land. So are the oldest ones the
          store drops as new ones come: nothing is dropped while the reader is
          not kept at the end (holdKey). A late-loading image is
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
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
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

          {/* A side chat with nothing after its first row: what it is for, under it. */}
          {emptyState && renderItems.length > 0 && renderItems.every(isSideChatStart) && hiddenQueuedCount === 0 && !thread.streamingAssistant && emptyState}

          {!selecting && thread.streamingAssistant
            ? (() => {
                const wakeId = thread.streamingAssistant.wakeId;
                const provenance = renderedWakeProvenanceIds.has(wakeId)
                  ? null
                  : provenanceForWake(thread.wakeReasonsById.get(wakeId) ?? null);
                if (provenance) renderedWakeProvenanceIds.add(wakeId);
                // Its words carry its key as a row (arriving-rows): they rise as they start.
                const streamingKey = `streaming-${wakeId}`;
                const streaming = <StreamingAssistantMessage text={streamingText} rowKey={streamingKey} />;
                return provenance ? (
                  <AssistantReplyGroup key={streamingKey} provenance={provenance}>
                    {streaming}
                  </AssistantReplyGroup>
                ) : (
                  <Fragment key={streamingKey}>{streaming}</Fragment>
                );
              })()
            : null}

          {!selecting && inProgressLines?.user && (
            <UserMessage
              key="voice-in-progress-user"
              text={inProgressLines.user.text}
              status="persisted"
              voiceMarker
              ephemeral
            />
          )}
          {!selecting && inProgressLines?.assistant && (
            <EphemeralAssistantBubble
              key="voice-in-progress-assistant"
              text={inProgressLines.assistant.text}
            />
          )}

          {!selecting && <WorkingIndicator line={working} />}
          {!selecting && !turnRunning && waiting.length > 0 && <WaitingLines lines={waiting} />}
          {/* Room for the bar below, so it covers no last line. */}
          {jumpShown && <div aria-hidden data-slot="jump-room" className="h-12 shrink-0" />}

        </div>
      </div>

      {(showLatest || jumpShown) && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2">
          {jumpShown && fresh !== null && (
            <Button
              variant="outline"
              className="h-9 gap-1.5 rounded-full bg-panel px-3.5 shadow-md"
              aria-label="Jump to the first new reply"
              onClick={jumpToNew}
            >
              <ArrowUp className="h-4 w-4 text-status-review" />
              {fresh.count === 1 ? "1 new reply" : `${fresh.count} new replies`}
            </Button>
          )}
          {showLatest && (
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9 rounded-full shadow-md bg-panel"
              aria-label="Scroll to latest message"
              onClick={scrollToLatest}
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
    </PendingMonitorsContext.Provider>
    </ToolNamesContext.Provider>
    </ShareBeginContext.Provider>
  );
}

/** A person's message. */
function UserTextMessage({ message: m, agentName, sender, foldKey, foldOpen, onFoldChange, summaryOpen = false, askedHere, onJumpToQuestion }: {
  message: AgentMessage;
  agentName: string;
  sender?: string;
  foldKey?: string;
  foldOpen?: boolean;
  onFoldChange?: (key: string, open: boolean) => void;
  /** A side chat's summary on it is open. */
  summaryOpen?: boolean;
  askedHere: ReadonlySet<string>;
  onJumpToQuestion: (questionId: string) => void;
}) {
  // One list per message, so the bubble's memo holds while a reply streams.
  const answers = useMemo(() => answersOf(m.content), [m.content]);
  const mentions = useMemo(() => mentionsOf(m.content), [m.content]);
  const pageQuotes = useMemo(() => pageQuotesOf(m.content), [m.content]);
  // A side chat sent to the personal agent: its summary's card, then the note; what
  // the model read of it is not drawn.
  const sideChat = m.content.type === "text" ? m.content.sideChat : undefined;
  const text = sideChat ? sideChat.note : m.content.type === "text" ? m.content.text : "";
  const attachments = m.content.type === "text" ? (m.content.attachments ?? []) : [];
  const bubble = (
    <UserMessage
      text={text}
      attachments={attachments}
      status="persisted"
      voiceMarker={m.source === "voice"}
      relayLabel={relayLabelOf(m, agentName)}
      task={relayTaskOf(m)}
      sender={sender}
      foldKey={foldKey}
      foldOpen={foldOpen}
      onFoldChange={onFoldChange}
      {...(answers.length > 0 ? { answers, jumpable: askedHere, onJumpToQuestion } : {})}
      {...(mentions.length > 0 ? { mentions } : {})}
      {...(pageQuotes.length > 0 ? { pageQuotes } : {})}
    />
  );
  if (!sideChat) return bubble;
  return (
    // Stretched, so the bubble is as wide as any; the card keeps to the right itself.
    <div className="flex flex-col gap-1.5">
      <SideChatSummaryCard part={sideChat} open={summaryOpen} onOpenChange={(open) => onFoldChange?.(sideChatSummaryOpenKey(m.id), open)} />
      {(sideChat.note || attachments.length > 0) && bubble}
    </div>
  );
}

/** The task a relayed brief was sent for. */
function relayTaskOf(m: AgentMessage): { id: string; tooltip: string } | undefined {
  const taskId = m.content.type === "text" ? m.content.relay?.taskId : undefined;
  return taskId ? { id: taskId, tooltip: "Sent with the task's description" } : undefined;
}

/** "via <name>" under a message the personal agent sent for the user, "· Voice"
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
