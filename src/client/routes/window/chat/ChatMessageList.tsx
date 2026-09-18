import {
  startTransition,
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactNode } from "react";
import type { AgentMessage, ThreadState, PendingMessage } from "@/store/agent-chat";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, AlertCircle, X } from "lucide-react";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { SystemMessage } from "./SystemMessage";
import { StreamingAssistantMessage } from "./StreamingAssistantMessage";
import { WakePhaseIndicator } from "./WakePhaseIndicator";
import { CompressionPhaseIndicator } from "./CompressionPhaseIndicator";
import { CompressionSummaryMessage } from "./CompressionSummaryMessage";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import { WorkItemMessageBlock } from "./WorkItemMessageBlock";
import { FeatureEventLine } from "./FeatureEventLine";
import { FeatureMessageLine } from "./FeatureMessageLine";
import { ChatProvenanceLine } from "./ChatProvenanceLine";
import {
  provenanceForSystemMessage,
  provenanceForWake,
  type ChatProvenance
} from "./chatProvenance";
import { describeFold, foldSystemRuns, type SystemClassification } from "./fold-system-runs";
import { FoldedSystemRun } from "./FoldedSystemRun";
import type { ToolResultSpec } from "./ToolCallCard";
import type { VoiceTranscriptLine } from "@/store/voice";
import { formatUserFacingError } from "@/lib/error-message";
import { formatCalendarDate, formatClockTime } from "@/lib/format";

function EphemeralAssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-1 opacity-70">
      <VoiceMarkerHeader ephemeral />
      {text && (
        <div className="text-sm leading-[1.6] whitespace-pre-wrap break-words">{text}</div>
      )}
    </div>
  );
}

function AssistantReplyGroup({
  provenance,
  children
}: {
  provenance: ChatProvenance;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <ChatProvenanceLine provenance={provenance} grouped />
      {children}
    </div>
  );
}

/** The only place in the transcript that says what DAY it is. Every other
 *  timestamp is a bare clock, so without this a message from last week and one
 *  from ten minutes ago read identically. */
function ChatDateSeparator({ timestamp, label }: { timestamp: string; label: string }) {
  return (
    // `aria-label`, not just the text: `separator` makes its children
    // presentational, so a screen reader would announce the rule and drop the
    // date. The `<time>` stays for the machine-readable `datetime`.
    <div
      className="my-1 flex items-center gap-3 text-2xs text-faint"
      role="separator"
      aria-label={label}
    >
      <span aria-hidden className="h-px flex-1 bg-border-soft" />
      <time className="shrink-0 tabular-nums" dateTime={timestamp}>
        {label}
      </time>
      <span aria-hidden className="h-px flex-1 bg-border-soft" />
    </div>
  );
}

/** An assistant reply with no text and no tool calls. `AssistantMessage`
 *  renders such a message as nothing (canvas references come from tool
 *  results, so no tool calls means none of those either); whether the ROW is
 *  visible then depends solely on whether its wake carries provenance. */
function isEmptyAssistantReply(m: AgentMessage): boolean {
  return (
    m.role === "assistant" &&
    m.content.type === "assistant" &&
    !m.content.text?.trim() &&
    !(m.content.toolCalls?.length)
  );
}

/** The wake reason for a message, falling back to the thread's per-wake map
 *  when the message itself does not carry one. */
function wakeReasonOf(m: AgentMessage, wakeReasonsById: ThreadState["wakeReasonsById"]) {
  return m.wakeReason ?? (m.wakeId ? (wakeReasonsById.get(m.wakeId) ?? null) : null);
}

/** Rows the switch below deliberately renders as nothing. A date separator must
 *  never be anchored to one: `ensureSystemMessage` seeds every thread with a
 *  hidden `role: "system"` row at seq 0, and if that row opened the day, the
 *  heading would sit over an empty stretch of transcript and the day's first
 *  VISIBLE message would then be judged as "same day, no separator needed".
 *
 *  An empty assistant reply whose wake has no provenance is the other such row:
 *  `AssistantMessage` returns null for it and there is no provenance line to
 *  stand in, so nothing reaches the DOM. (With provenance it IS a visible row —
 *  a heartbeat no-op — and `classifySystem` treats it as system.) */
function rendersNothing(
  item: { kind: "msg"; message: AgentMessage } | { kind: "pending" },
  wakeReasonsById: ThreadState["wakeReasonsById"]
) {
  if (item.kind !== "msg") return false;
  const m = item.message;
  if (m.role === "system") return true;
  return (
    isEmptyAssistantReply(m) &&
    provenanceForWake(wakeReasonOf(m, wakeReasonsById), { wakeId: m.wakeId, createdAt: m.createdAt }) ===
      null
  );
}

interface ChatMessageListProps {
  thread: ThreadState;
  onLoadOlder: () => Promise<void>;
  onRetryFailed: (localId: string) => void;
  onDismissError: () => void;
  hideQueuedPending?: boolean;
  showEmptyHelp?: boolean;
  /** Ephemeral in-progress voice transcripts to render at the bottom.
   *  Keyed by speaker; null when no streaming for that speaker. */
  inProgressLines?: { user: VoiceTranscriptLine | null; assistant: VoiceTranscriptLine | null };
  /** Called when the user clicks "View full item" on a work item reference message. */
  onOpenWorkItem?: (itemId: string) => void;
}

const STICKY_BOTTOM_PX = 100;
/** Rows rendered on mount before the rest is released. Roughly two screenfuls,
 *  so the user can scroll a little before the full list arrives. */
const INITIAL_RENDER_WINDOW = 24;
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
  onDismissError,
  hideQueuedPending = false,
  showEmptyHelp = true,
  inProgressLines,
  onOpenWorkItem
}: ChatMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastMessageCountRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  const hasInitialScrollRef = useRef(false);
  const shouldStickToBottomRef = useRef(true);
  const [newCount, setNewCount] = useState(0);
  const [scrolledAwayFromBottom, setScrolledAwayFromBottom] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  // Per run, per session: which folded system runs are showing their rows.
  // Not persisted, reset with the thread.
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const streamingText = useThrottledValue(
    thread.streamingAssistant?.totalText ?? "",
    STREAMING_RENDER_INTERVAL_MS
  );
  const bottomEphemeralKey = [
    thread.wakePhase.phase,
    thread.wakePhase.activeToolCallId ?? "",
    thread.wakePhase.activeToolName ?? "",
    thread.compressionPhase?.compressionId ?? "",
    inProgressLines?.user?.text ?? "",
    inProgressLines?.assistant?.text ?? ""
  ].join("\u0001");

  const { renderItems, toolResultsByCallId, hiddenQueuedCount } = useMemo(() => {
    const toolResultsByCallId = new Map<string, ToolResultSpec>();
    for (const m of thread.messages) {
      if (m.role !== "tool" || m.content.type !== "tool_result") continue;
      toolResultsByCallId.set(m.content.toolCallId, {
        result: m.content.result,
        isError: m.content.isError,
        error: m.content.error,
        createdAt: m.createdAt
      });
    }
    const renderItems: Array<
      { kind: "msg"; message: AgentMessage } | { kind: "pending"; pending: PendingMessage }
    > = [];
    for (const m of thread.messages) {
      if (m.role === "tool") continue;
      renderItems.push({ kind: "msg", message: m });
    }
    let hiddenQueuedCount = 0;
    for (const p of thread.pendingUserMessages.values()) {
      if (hideQueuedPending && p.status === "queued") {
        hiddenQueuedCount++;
        continue;
      }
      if (p.status === "sent" && p.messageId && thread.messages.some((m) => m.id === p.messageId))
        continue;
      renderItems.push({ kind: "pending", pending: p });
    }
    return { renderItems, toolResultsByCallId, hiddenQueuedCount };
  }, [hideQueuedPending, thread.messages, thread.pendingUserMessages]);

  // Mounting the transcript renders every message in one synchronous pass, and
  // with a long thread that was measured at ~80ms of React reconciliation —
  // enough to eat the dock's open animation. The list opens pinned to the
  // bottom, so all but the last screenful is work the user cannot see yet.
  //
  // Render a window first, then release the rest once the browser has painted.
  // The cost doesn't disappear, it just stops landing on the frame that has to
  // animate. (content-visibility was tried first and measured as a no-op here:
  // the bottleneck is reconciliation, not layout or paint.)
  const [renderWindow, setRenderWindow] = useState(INITIAL_RENDER_WINDOW);
  const windowedItems = useMemo(
    () => (renderItems.length > renderWindow ? renderItems.slice(-renderWindow) : renderItems),
    [renderItems, renderWindow]
  );
  // What counts as a "system" row for folding: user-role rows that are feature
  // events or carry system provenance (context snapshots, watch, alarm, …), and
  // assistant replies that said nothing but whose wake shows provenance (a
  // heartbeat no-op). Anything the user or the model actually said breaks a run.
  type RenderItem = (typeof windowedItems)[number];
  const classifySystem = useCallback((item: RenderItem): SystemClassification | null => {
    if (item.kind !== "msg") return null;
    const m = item.message;
    if (m.role === "user") {
      if (m.content.type === "feature_event") return { label: "FEATURE", createdAt: m.createdAt };
      const provenance = provenanceForSystemMessage(m);
      return provenance ? { label: provenance.label, createdAt: m.createdAt } : null;
    }
    if (isEmptyAssistantReply(m)) {
      const provenance = provenanceForWake(wakeReasonOf(m, thread.wakeReasonsById), {
        wakeId: m.wakeId,
        createdAt: m.createdAt
      });
      return provenance ? { label: provenance.label, createdAt: m.createdAt } : null;
    }
    return null;
  }, [thread.wakeReasonsById]);

  const foldedItems = useMemo(
    () =>
      foldSystemRuns(
        windowedItems,
        classifySystem,
        (item) => (item.kind === "pending" ? item.pending.localId : item.message.id)
      ),
    [windowedItems, classifySystem]
  );

  type FoldedTranscriptEntry = (typeof foldedItems)[number];
  const datedWindowedItems = useMemo(() => {
    const dated: Array<
      | FoldedTranscriptEntry
      | { kind: "date"; key: string; timestamp: string; label: string }
    > = [];
    let previousDate = "";
    for (const entry of foldedItems) {
      if (entry.kind === "item" && rendersNothing(entry.item, thread.wakeReasonsById)) {
        dated.push(entry);
        continue;
      }
      const timestamp = entry.kind === "fold"
        ? (entry.start ?? "")
        : entry.item.kind === "pending" ? entry.item.pending.createdAt : entry.item.message.createdAt;
      const label = formatCalendarDate(timestamp);
      if (label && label !== previousDate) {
        const key = entry.kind === "fold"
          ? entry.key
          : entry.item.kind === "pending" ? entry.item.pending.localId : entry.item.message.id;
        dated.push({ kind: "date", key, timestamp, label });
        previousDate = label;
      }
      dated.push(entry);
    }
    return dated;
  }, [foldedItems, thread.wakeReasonsById]);
  const isWindowed = windowedItems.length < renderItems.length;

  useEffect(() => {
    if (!isWindowed) return;
    // Two frames: one to paint the windowed list, one to be sure it landed
    // before the rest is queued at low priority.
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => startTransition(() => setRenderWindow(Number.POSITIVE_INFINITY)))
    );
    return () => cancelAnimationFrame(raf);
  }, [isWindowed]);

  // Releasing the window puts every older message ABOVE the ones already on
  // screen, so the transcript grows upward while scrollTop stays the number it
  // was — which now points into the middle of a much taller list. On a sixty
  // message thread that lands 2135px above the bottom, i.e. squarely on older
  // messages, and it is the frame the user sees.
  //
  // The pin effect below cannot catch it: its deps are renderItems.length and
  // friends, and none of them move here — the full list was always the full
  // list, only the slice changed. The content observer does catch it, but it
  // runs off a ResizeObserver, which means after that frame has been painted.
  // A layout effect runs after the DOM is updated and BEFORE the paint, so the
  // intermediate position is never shown.
  //
  // Only on the release, and only finite -> Infinity: pinning on every window
  // change would fight a reader who has scrolled up. Scroll anchoring used to
  // absorb this for free; 3ee4422 turned it off on purpose (it was moving
  // scrollTop during resizes and stranding the transcript), so the cost of
  // that trade gets paid here, explicitly.
  const previousRenderWindowRef = useRef(renderWindow);
  useLayoutEffect(() => {
    const previous = previousRenderWindowRef.current;
    previousRenderWindowRef.current = renderWindow;
    if (Number.isFinite(renderWindow) || !Number.isFinite(previous)) return;
    const el = scrollRef.current;
    if (!el || !shouldStickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
    lastScrollHeightRef.current = el.scrollHeight;
  }, [renderWindow]);

  useEffect(() => {
    setExpandedToolIds(new Set());
    setExpandedFolds(new Set());
    hasInitialScrollRef.current = false;
    lastMessageCountRef.current = 0;
    lastScrollHeightRef.current = 0;
    shouldStickToBottomRef.current = true;
    setRenderWindow(INITIAL_RENDER_WINDOW);
    // Back to finite alongside renderWindow, so the next release is seen as one.
    // Left at Infinity, switching threads would skip the re-pin and land the new
    // transcript exactly where this bug used to.
    previousRenderWindowRef.current = INITIAL_RENDER_WINDOW;
    setNewCount(0);
    setScrolledAwayFromBottom(false);
  }, [thread.threadId]);

  const updateBottomState = useCallback((el: HTMLDivElement) => {
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const away = distanceFromBottom > STICKY_BOTTOM_PX;
    shouldStickToBottomRef.current = !away;
    setScrolledAwayFromBottom((current) => (current === away ? current : away));
    if (!away) setNewCount(0);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) updateBottomState(el);
  }, [updateBottomState]);

  const handleToolExpandedChange = useCallback((toolCallId: string, expanded: boolean) => {
    setExpandedToolIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(toolCallId);
      else next.delete(toolCallId);
      return next;
    });
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf: number | null = null;

    const keepPinnedToBottom = () => {
      // Cancel before the guard, not after it: a pin scheduled by an earlier
      // event must not survive an event that decides we should no longer be
      // pinned. Leaving it queued would scroll the user back down after they
      // had just scrolled away.
      if (raf !== null) {
        window.cancelAnimationFrame(raf);
        raf = null;
      }
      if (!shouldStickToBottomRef.current || expandedToolIds.size > 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = null;
        const node = scrollRef.current;
        if (!node || !shouldStickToBottomRef.current) return;
        node.scrollTop = node.scrollHeight;
        updateBottomState(node);
      });
    };

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepPinnedToBottom);
    observer?.observe(el);

    // The observer above watches the scroller's own box, which does not change
    // when the transcript grows — so on its own it never sees content arrive.
    // That gap used to be covered by scroll anchoring, which we turned off, and
    // it is not theoretical: the markdown renderer is loaded lazily, so on open
    // it lands ~150ms after the transcript has already been pinned and adds
    // ~144px across the messages, leaving the newest content below the fold.
    // Streaming, an expanding composer and the mobile keyboard all grow content
    // the same way. Watching each row's box catches all of it, and the pin is
    // still gated on shouldStickToBottomRef, so a reader who has scrolled up is
    // never dragged back down.
    const contentObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(keepPinnedToBottom);
    //
    // The rows live inside the centring column, not directly under the
    // scroller, so that is the element whose children are watched; the
    // fallback to `el` only matters if the column is ever removed.
    const column = el.querySelector('[data-slot="transcript-column"]') ?? el;
    const observeRows = () => {
      if (!contentObserver) return;
      contentObserver.disconnect();
      for (const row of column.children) contentObserver.observe(row);
    };
    observeRows();
    // Rows come and go as messages arrive and as the render window releases;
    // childList only, so a streaming delta inside a row costs nothing here —
    // that growth is already caught by that row's own box.
    const rowsChanged =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(observeRows);
    rowsChanged?.observe(column, { childList: true });

    const vv = window.visualViewport;
    vv?.addEventListener("resize", keepPinnedToBottom);
    vv?.addEventListener("scroll", keepPinnedToBottom);

    return () => {
      observer?.disconnect();
      contentObserver?.disconnect();
      rowsChanged?.disconnect();
      vv?.removeEventListener("resize", keepPinnedToBottom);
      vv?.removeEventListener("scroll", keepPinnedToBottom);
      if (raf !== null) window.cancelAnimationFrame(raf);
    };
  }, [expandedToolIds.size, updateBottomState]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Source of truth for "is the user currently pinned to bottom" is
    // shouldStickToBottomRef, maintained by the scroll handler + ResizeObserver
    // with the STICKY_BOTTOM_PX threshold. Trust it directly — don't recompute
    // from cached scrollHeight, which gets out of sync with current scrollTop /
    // clientHeight when the input textarea grows/shrinks during the same render.
    // If the user has scrolled up to read history, sending a new message does
    // NOT force-scroll them down; they see the "N new" badge instead.
    const stickySuspended = expandedToolIds.size > 0;
    const grew =
      renderItems.length > lastMessageCountRef.current ||
      el.scrollHeight !== lastScrollHeightRef.current;
    if (grew) {
      // First time we have content (drawer just opened, thread loaded) —
      // jump to the latest message instead of leaving the user staring at
      // the top of a long history.
      if (!hasInitialScrollRef.current && renderItems.length > 0) {
        el.scrollTop = el.scrollHeight;
        setNewCount(0);
        updateBottomState(el);
        hasInitialScrollRef.current = true;
      } else if (shouldStickToBottomRef.current && !stickySuspended) {
        el.scrollTop = el.scrollHeight;
        setNewCount(0);
        updateBottomState(el);
      } else if (renderItems.length > lastMessageCountRef.current) {
        setNewCount((n) => n + (renderItems.length - lastMessageCountRef.current));
        updateBottomState(el);
      } else {
        updateBottomState(el);
      }
    }
    lastMessageCountRef.current = renderItems.length;
    lastScrollHeightRef.current = el.scrollHeight;
  }, [
    renderItems.length,
    streamingText,
    bottomEphemeralKey,
    expandedToolIds.size,
    updateBottomState
  ]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    shouldStickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewCount(0);
    setScrolledAwayFromBottom(false);
  };

  const handleLoadOlder = async () => {
    const el = scrollRef.current;
    if (!el) return;
    const beforeHeight = el.scrollHeight;
    setLoadingOlder(true);
    try {
      await onLoadOlder();
      const afterHeight = el.scrollHeight;
      el.scrollTop = afterHeight - beforeHeight;
      updateBottomState(el);
    } finally {
      setLoadingOlder(false);
    }
  };

  const renderedWakeProvenanceIds = new Set<string>();

  /** One transcript row. Declared here so a fold can render its items through
   *  exactly the same path a top-level row takes: an expanded fold marks its
   *  wake ids in `renderedWakeProvenanceIds`, a collapsed one does not. */
  function renderTranscriptItem(item: RenderItem): ReactNode {
    if (item.kind === "pending") {
      return (
        <UserMessage
          key={item.pending.localId}
          text={item.pending.content}
          attachments={item.pending.attachments ?? []}
          status={item.pending.status}
          error={item.pending.error}
          createdAt={item.pending.createdAt}
          onRetry={
            item.pending.status === "failed"
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
      return m.content.type === "summary" ? (
        <CompressionSummaryMessage key={m.id} message={m} />
      ) : (
        <SystemMessage key={m.id} message={m} />
      );
    }
    if (m.role === "user" && m.source === "watch") {
      return <SystemMessage key={m.id} message={m} />;
    }
    if (m.role === "user" && (m.source === "alarm" || m.source === "scheduled")) {
      return <SystemMessage key={m.id} message={m} />;
    }
    if (m.role === "user" && m.source === "analyzer-event") {
      return <SystemMessage key={m.id} message={m} />;
    }
    if (m.role === "user" && (m.source === "runtime-context" || m.source === "restart-recovery")) {
      return <SystemMessage key={m.id} message={m} />;
    }
    if (m.role === "user" && m.source === "feature-message") {
      return <FeatureMessageLine key={m.id} message={m} />;
    }
    if (m.role === "user" && m.content.type === "feature_event") {
      return <FeatureEventLine key={m.id} content={m.content} createdAt={m.createdAt} />;
    }
    if (m.role === "user") {
      // Work item reference injected by the server — render as a compact block.
      if (m.content.type === "text") {
        const workItemRef = m.content.metadata?.workItemRef as { itemId: string } | undefined;
        if (workItemRef?.itemId && onOpenWorkItem) {
          const text = m.content.text;
          const attachments = m.content.attachments ?? [];
          if (!isWorkItemReferenceOnlyText(text) || attachments.length > 0) {
            return (
              <Fragment key={m.id}>
                <WorkItemMessageBlock
                  itemId={workItemRef.itemId}
                  fallbackTitle={extractWorkItemTitle(text)}
                  fallbackBody={extractWorkItemBody(text)}
                  onOpen={onOpenWorkItem}
                />
                <UserMessage
                  text={text}
                  attachments={attachments}
                  status="persisted"
                  createdAt={m.createdAt}
                  voiceMarker={m.source === "voice"}
                />
              </Fragment>
            );
          }
          return (
            <WorkItemMessageBlock
              key={m.id}
              itemId={workItemRef.itemId}
              fallbackTitle={extractWorkItemTitle(text)}
              fallbackBody={extractWorkItemBody(text)}
              onOpen={onOpenWorkItem}
            />
          );
        }
      }
      const text = m.content.type === "text" ? m.content.text : "";
      const attachments = m.content.type === "text" ? (m.content.attachments ?? []) : [];
      return (
        <UserMessage
          key={m.id}
          text={text}
          attachments={attachments}
          status="persisted"
          createdAt={m.createdAt}
          voiceMarker={m.source === "voice"}
        />
      );
    }
    if (m.role === "assistant") {
      const wakeMetadata = m.wakeMetadata ??
        (m.wakeId ? (thread.wakeMetadataById.get(m.wakeId) ?? null) : null);
      const provenance = provenanceForWake(
        m.wakeReason ?? (m.wakeId ? (thread.wakeReasonsById.get(m.wakeId) ?? null) : null),
        { wakeId: m.wakeId, createdAt: m.createdAt, metadata: wakeMetadata }
      );
      const showProvenance = provenance && (!m.wakeId || !renderedWakeProvenanceIds.has(m.wakeId));
      if (showProvenance && m.wakeId) renderedWakeProvenanceIds.add(m.wakeId);
      const assistant = (
        <AssistantMessage
          message={m}
          toolResultsByCallId={toolResultsByCallId}
          activeToolCallId={thread.wakePhase.activeToolCallId ?? null}
          expandedToolIds={expandedToolIds}
          onToolExpandedChange={handleToolExpandedChange}
          voiceMarker={m.source === "voice"}
          // The provenance row above this reply already carries the same
          // clock (it is built from this message's createdAt); a second copy
          // one line down was the same second printed twice.
          hideClock={Boolean(showProvenance)}
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
    if (m.role === "system") {
      return null;
    }
    return null;
  }

  return (
    /* Container context for the transcript's narrow-width rules. Deliberately
       on this wrapper and not on the scroller below: `@container` implies
       `contain: layout inline-size`, and the scroller owns scroll position and
       stick-to-bottom. Same inline size, none of the risk. */
    <div className="@container relative flex-1 min-h-0 min-w-0">
      {/* `overflow-anchor:none` is a deliberate trade, not a cleanup. Read both
          halves before touching it.

          WHAT IT BUYS. The browser otherwise shifts scrollTop during any reflow
          to hold the content you were looking at steady, and fires a scroll
          event for a scroll the user never made. The tool rows gain a second
          line below the 34rem threshold, so one resize across it grows the
          transcript by more than STICKY_BOTTOM_PX at once; that phantom scroll
          reaches handleScroll, reads as "scrolled away", clears
          shouldStickToBottomRef — and the transcript silently stops following
          the conversation, on nothing but a dock resize. Double-clicking the
          resize handle snaps to an equal split and can cross that threshold
          in one step.

          WHAT IT COSTS. Content that grows ABOVE a scrolled-up reader is no
          longer compensated, so what they are reading can shift under them.
          Load-older is covered — handleLoadOlder measures and repositions by
          hand, at 0px drift. The lazily-loaded MarkdownView chunk arriving
          ~150ms after mount is NOT covered, nor is any late-loading image: a
          reader who has scrolled up inside that window will see the content
          move. Accepted as a bounded cosmetic residual — one arrival shortly
          after mount, nothing corrupted, the pin and the affordance unaffected.

          DO NOT restore `overflow-anchor: auto` to fix that shifting. It brings
          the phantom-scroll unpin straight back. The fix, if it is ever worth
          making, is to compensate manually the way handleLoadOlder already
          does: measure scrollHeight before and after and adjust scrollTop. */}
      <div
        ref={scrollRef}
        className="h-full min-w-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none] scrollbar-thin px-7 py-4 flex flex-col gap-4"
        onScroll={handleScroll}
      >
        <div data-slot="transcript-column" className="mx-auto flex w-full max-w-[880px] flex-col gap-4">
          {thread.hasMoreOlder && (
            <div className="flex justify-center mb-1">
              <Button variant="ghost" size="sm" onClick={handleLoadOlder} disabled={loadingOlder}>
                <ArrowUp className="h-3 w-3" />
                {loadingOlder ? "Loading…" : "Load 50 older"}
              </Button>
            </div>
          )}

          {renderItems.length === 0 && hiddenQueuedCount === 0 && !thread.streamingAssistant && (
            <div className="flex flex-col items-center justify-center text-center text-sm text-muted-foreground py-8 px-3">
              <p className="font-medium text-foreground">No messages yet</p>
              {showEmptyHelp && (
                <>
                  <p className="mt-2 text-xs">
                    The agent has access to bash, file editing, and your tmux panes.
                  </p>
                  <p className="mt-2 text-xs italic">
                    Try:{" "}
                    <span className="font-mono not-italic">
                      "what's running in this feature right now?"
                    </span>
                  </p>
                </>
              )}
            </div>
          )}

          {datedWindowedItems.map((entry) => {
            if (entry.kind === "date") {
              return (
                <ChatDateSeparator
                  key={`date-${entry.key}`}
                  timestamp={entry.timestamp}
                  label={entry.label}
                />
              );
            }
            if (entry.kind === "fold") {
              const expanded = expandedFolds.has(entry.key);
              const toggle = () =>
                setExpandedFolds((current) => {
                  const next = new Set(current);
                  if (next.has(entry.key)) next.delete(entry.key);
                  else next.add(entry.key);
                  return next;
                });
              return (
                <Fragment key={`fold-${entry.key}`}>
                  <FoldedSystemRun
                    summary={describeFold(entry.counts, entry.start, entry.end, formatClockTime)}
                    expanded={expanded}
                    onToggle={toggle}
                  />
                  {expanded && entry.items.map((item) => renderTranscriptItem(item))}
                </Fragment>
              );
            }
            return renderTranscriptItem(entry.item);
          })}

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
                const streaming = <StreamingAssistantMessage text={streamingText} />;
                return provenance ? (
                  <AssistantReplyGroup key={`streaming-${wakeId}`} provenance={provenance}>
                    {streaming}
                  </AssistantReplyGroup>
                ) : (
                  <Fragment key={`streaming-${wakeId}`}>{streaming}</Fragment>
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

          <WakePhaseIndicator
            phase={thread.wakePhase.phase}
            toolName={thread.wakePhase.activeToolName}
          />
          <CompressionPhaseIndicator active={!!thread.compressionPhase} />

          {thread.lastWakeError && (
            <div className="mx-3 my-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-destructive">
                  {thread.lastWakeError.status === "limit_reached"
                    ? "Wake hit step limit"
                    : "Agent wake failed"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground break-words whitespace-pre-wrap">
                  {formatUserFacingError(thread.lastWakeError.message)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Dismiss error"
                className="shrink-0"
                onClick={onDismissError}
              >
                <X />
              </Button>
            </div>
          )}
        </div>
      </div>

      {(newCount > 0 || scrolledAwayFromBottom) && (
        <Button
          variant="outline"
          size="icon"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 h-9 w-9 rounded-full shadow-md bg-panel"
          aria-label="Scroll to latest message"
          onClick={scrollToBottom}
        >
          <ArrowDown className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers for parsing work-item reference messages
// ---------------------------------------------------------------------------

function extractWorkItemTitle(text: string): string {
  const m = text.match(/^📌 \[Work item: (.+?)\]/);
  return m?.[1] ?? "(Work item)";
}

function isWorkItemReferenceOnlyText(text: string): boolean {
  return /^📌 \[Work item: .+?\]/.test(text.trimStart());
}

function extractWorkItemBody(text: string): string {
  const lines = text.split("\n");
  const collected: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("---") || line.startsWith("User comment:")) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}
