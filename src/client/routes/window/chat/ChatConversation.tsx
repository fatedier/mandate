import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { TranscriptPlace } from "./useTranscriptViewport";
import { X } from "lucide-react";
import { useAgentChat } from "@/hooks/useAgentChat";
import { useOpenQuestions } from "@/hooks/useOpenQuestions";
import { useWorkerStrip } from "@/hooks/useWorkerStrip";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { OpenQuestion } from "@shared/questions";
import { scopeKey, useAgentChatStore, type AgentChatScope } from "@/store/agent-chat";
import { useVoiceStore } from "@/store/voice";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { useCommandsStore } from "@/store/commands";
import { Button } from "@/components/ui/button";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { errorText } from "@shared/error-text";
import { cn } from "@/lib/utils";
import { VoiceControlBar } from "@/routes/voice/VoiceControlBar";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { Mention } from "@shared/mentions";
import type { PageQuote } from "@shared/page-quotes";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { QuestionDock } from "./QuestionDock";
import { Shown } from "@/components/Shown";
import { QuestionAnnouncer } from "./QuestionAnnouncer";
import { WorkerStrip } from "./WorkerStrip";
import type { WorkerStripRow } from "./worker-strip";
import { useHeldAnswers } from "./useHeldAnswers";
import { conversationState } from "./command-draft";
import { CHAT_COLUMN_MAX_PX, CHAT_GUTTER_CLASS } from "./chat-column";
import { ThreadModelControl } from "./ThreadModelControl";
import { ShareSelectionContext, useShareSelection } from "./share-selection-state";
import { ShareSelectionBar } from "./ShareSelectionBar";
import { ShareDialog } from "./ShareDialog";
import { cardItems, type ShareItem } from "./share-selection";

const NO_WORKERS: WorkerStripRow[] = [];

/** Where the transcript's first row would be: its gutters and column. */
function ChatColumnState({ children }: { children: ReactNode }) {
  return (
    <div className={cn("flex-1 px-(--chat-gutter) py-4", CHAT_GUTTER_CLASS)}>
      <div className="mx-auto w-full" style={{ maxWidth: CHAT_COLUMN_MAX_PX }}>{children}</div>
    </div>
  );
}

/** One quiet line above the composer, with a way to dismiss it: where voice
 *  says it stopped, and what a typed command answered. */
function ComposerNotice({ slot, children, onDismiss }: { slot: string; children: ReactNode; onDismiss: () => void }) {
  return (
    <div data-slot={slot} role="status" className="flex items-center justify-center gap-1 text-xs text-faint">
      <span>{children}</span>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={onDismiss} className="-my-1 shrink-0"><X className="size-3.5" /></Button>
    </div>
  );
}

/** One conversation: the manager thread on its page, or a worker's chat in
 *  its tab. The host draws the header; this draws the transcript and input. */
export function ChatConversation({ scope, emptyState, onOpenWorker, readOnlyNote, offerReadBeside, newSince = null }: {
  scope: AgentChatScope;
  /** Hands the page a way to read beside while scrolled up (the personal agent's
   *  chat, for its History button). */
  offerReadBeside?: (take: (() => TranscriptPlace | null) | null) => void;
  /** Shown instead of "No messages yet". */
  emptyState?: ReactNode;
  /** Report cards, work-item cards and the strip of workers at work open a worker here. */
  onOpenWorker?: (workerId: string) => void;
  /** A conversation nothing more can be sent to (an archived thread): this
   *  line stands where the composer was, and no turn can be continued. */
  readOnlyNote?: string;
  /** Where the user had read to when they came back (see useReadPoint):
   *  what came after it is marked as new. */
  newSince?: number | null;
}) {
  const { thread, send, retry, deleteQueued, loadOlder } = useAgentChat(scope);
  const ensureThreadLoaded = useAgentChatStore((s) => s.ensureThreadLoaded);
  const cancelWake = useAgentChatStore((s) => s.cancelWake);
  const retryWake = useAgentChatStore((s) => s.retryWake);
  const answerQuestion = useAgentChatStore((s) => s.answerQuestion);
  const continueTurn = useAgentChatStore((s) => s.continueTurn);
  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const connectionState = useVoiceStore((s) => s.connectionState);
  const stopNotice = useVoiceStore((s) => s.stopNotice);
  const resumeVoice = useVoiceStore((s) => s.resumeVoice);
  const dismissStopNotice = useVoiceStore((s) => s.dismissStopNotice);
  const stopVoice = useVoiceStore((s) => s.stopVoice);
  const inProgressLines = useVoiceStore((s) => s.inProgressLines);
  // Voice is the personal agent's: its page carries voice's bar, unless voice
  // went to another device (then Resume here takes it back).
  const isPersonal = scope.type === "personal";
  const voiceMoved = isPersonal && voiceMode && connectionState === "moved";
  const voiceHere = isPersonal && voiceMode && !voiceMoved;

  // A manager thread's entry exists (its id bound) before its first page
  // arrives, so an empty entry is not yet "an empty conversation".
  const key = scopeKey(scope);
  // Picking messages to share: this conversation's, ended by another one.
  const share = useShareSelection(key);
  // Share open: what was picked as it opened, for this conversation only.
  const [shareOpen, setShareOpen] = useState<{ key: string; items: ShareItem[] } | null>(null);
  // Another conversation shown closes it, as it ends the picking: coming back
  // (the browser's Back, then Forward) brings neither back.
  if (shareOpen !== null && shareOpen.key !== key) setShareOpen(null);
  const sharing = shareOpen !== null && shareOpen.key === key;
  useEffect(() => {
    if (!share.selecting || sharing) return;
    const leaveOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) share.leave(); };
    document.addEventListener("keydown", leaveOnEscape);
    return () => document.removeEventListener("keydown", leaveOnEscape);
  }, [share, sharing]);
  const commands = useCommandsStore((s) => s.byScope.get(key));
  const commandNotice = useCommandsStore((s) => s.noticeByScope.get(key) ?? null);
  const loadCommands = useCommandsStore((s) => s.load);
  const runCommand = useCommandsStore((s) => s.run);
  const sayCommand = useCommandsStore((s) => s.say);
  const [readyKey, setReadyKey] = useState<string | null>(null);
  const ready = readyKey === key;
  // Keyed by scope and thread: another conversation's failure never stands
  // here, nor does it outlive the thread it was for (a worker's chat is bound
  // to its thread at the first wake).
  const [loadError, setLoadError] = useState<{ key: string; threadId: string | null; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    const request = ensureThreadLoaded(scope);
    // The thread this read is for, taken after the call: a manager thread's
    // id is bound inside it. A failure lands on that thread only.
    const threadId = useAgentChatStore.getState().threadsByScope.get(key)?.threadId ?? null;
    Promise.resolve(request).then(
      () => { if (live) setReadyKey(key); },
      (err: unknown) => {
        if (!live) return;
        setLoadError({ key, threadId, message: errorText(err) });
        setReadyKey(key);
      }
    );
    return () => { live = false; };
  }, [ensureThreadLoaded, scope, key, attempt]);
  // The commands this conversation's server offers, asked for once, after
  // its page: the composer works without them until they arrive.
  useEffect(() => { if (!readOnlyNote) void loadCommands(scope); }, [loadCommands, scope, key, readOnlyNote]);

  const queuedMessages = useMemo(
    () => (thread ? [...thread.pendingUserMessages.values()].filter((m) => m.status === "queued") : []),
    [thread]
  );
  const handleSend = useCallback((content: string, attachments?: AgentMessageAttachment[], mentions?: Mention[], pageQuotes?: PageQuote[]) => {
    void send(content, attachments, mentions, pageQuotes);
  }, [send]);
  // The personal agent's and a manager thread's composers can @ a thread; a thread
  // is not offered to itself. A worker's cannot.
  const mentionTarget = useMemo(
    () => scope.type === "personal" || scope.type === "side_chat" || scope.type === "manager" ? { excludeId: scope.type === "manager" ? scope.threadId : null } : undefined,
    [scope]
  );
  // A typed command answers on the line above the composer.
  const handleCommand = useCallback(async (text: string, attachments: number) => {
    const result = await runCommand(scope, text, attachments);
    sayCommand(scope, result.message);
    return result.taken;
  }, [runCommand, sayCommand, scope]);
  const clearCommandNotice = useCallback(() => sayCommand(scope, null), [sayCommand, scope]);
  // The questions that wait for the user here stand over the composer; a
  // suggested answer is sent as their own message.
  const questions = useOpenQuestions(scope);
  const openQuestionIds = useMemo(() => new Set(questions.map((question) => question.id)), [questions]);
  const sendAnswer = useCallback(async (question: OpenQuestion, label: string) => {
    const reason = await answerQuestion(scope, question, label);
    // Refused: the question may have closed elsewhere, its event missed here.
    if (reason && scope.type === "manager") void useManagerThreadsStore.getState().refresh(scope.threadId);
    if (reason && scope.type === "personal") void usePersonalAgentStore.getState().refresh();
    return reason;
  }, [answerQuestion, scope]);
  const skipQuestion = useAgentChatStore((s) => s.skipQuestion);
  const sendSkip = useCallback(async (question: OpenQuestion) => {
    const reason = await skipQuestion(scope, question.id);
    if (reason && scope.type === "manager") void useManagerThreadsStore.getState().refresh(scope.threadId);
    if (reason && scope.type === "personal") void usePersonalAgentStore.getState().refresh();
    return reason;
  }, [skipQuestion, scope]);
  const answers = useHeldAnswers(sendAnswer, questions, sendSkip);
  // The last question went with the focus in it: the composer has it next,
  // once (a composer drawn again later is not focused for it).
  const composerId = useId();
  const leaveForComposer = useCallback(() => { document.getElementById(composerId)?.focus(); }, [composerId]);
  // The question over the composer rises in as it is asked and fades out as
  // it goes (Shown); one there as the conversation opened is just there.
  // Drawn until it has gone: only then is nothing above the composer.
  const asking = questions.length > 0;
  // While its agent works, a question waits folded: the reply first.
  const working = thread ? thread.wakePhase.phase !== "idle" : false;
  const [dock, setDock] = useState<"opened" | "arrived" | "gone">(asking ? "opened" : "gone");
  if (asking && dock === "gone") setDock("arrived");
  const dockGone = useCallback(() => setDock("gone"), []);
  // Memoised: the composer is not drawn again for each piece of a reply.
  const questionDock = useMemo(
    () => (dock === "gone" ? null : (
      <Shown
        when={asking}
        appear={dock === "arrived"}
        enter="animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
        exit="animate-out fade-out-0 duration-150"
        className="flex min-h-0 flex-col"
        onGone={dockGone}
        onFocusOut={leaveForComposer}
      >
        <QuestionDock questions={questions} answers={answers} working={working} onLeave={leaveForComposer} />
      </Shown>
    )),
    [dock, asking, dockGone, questions, answers, working, leaveForComposer]
  );
  // What is at work for this conversation and will come back to it, over the
  // question: the question is the one that wants the user, so it stands
  // nearest the composer. A manager thread's workers, drawn where their lines
  // can open what they name; any conversation's background tasks. An
  // archived conversation's tasks were stopped with it.
  const isMobile = useIsMobile();
  const stripThreadId = scope.type === "worker" ? thread?.threadId ?? null : scope.threadId;
  // A row's steps or list closing as the strip changes its shape leave
  // focus nowhere: it goes to the row that replaced the one they opened from,
  // else to the composer.
  const rootRef = useRef<HTMLDivElement>(null);
  const stripFocus = useCallback(({ composer }: { composer: boolean }) => {
    const root = rootRef.current;
    const row = root?.querySelector<HTMLElement>('[data-slot="worker-strip"] [data-slot="task-strip-open"], [data-slot="worker-strip"] [data-slot="task-strip-group"]');
    return row ?? (composer ? root?.querySelector<HTMLElement>('[data-slot="composer"] textarea') ?? null : null);
  }, []);
  const { workers, tasks, pinned, holdTask, holdList } = useWorkerStrip({
    workersOf: scope.type === "manager" ? scope.threadId : null,
    tasksOf: readOnlyNote ? null : stripThreadId
  });
  // The thread's model in the composer's toolbar: a subagent's runs on its
  // parent's and has no composer of its own to switch it.
  const modelThreadId = scope.type === "subagent" ? null : stripThreadId;
  const runningWakeId = thread && thread.wakePhase.phase !== "idle" ? thread.wakePhase.wakeId : null;
  const modelTool = useMemo(
    () => (modelThreadId ? <ThreadModelControl threadId={modelThreadId} wakeId={runningWakeId} /> : undefined),
    [modelThreadId, runningWakeId]
  );
  const aboveComposer = useMemo(() => {
    const workerRows = onOpenWorker ? workers : NO_WORKERS;
    const strip = workerRows.length > 0 || tasks.length > 0
      ? <WorkerStrip rows={workerRows} tasks={tasks} threadId={stripThreadId} compact={isMobile} onOpen={onOpenWorker} onTaskPeek={holdTask} pinned={pinned} onListOpen={holdList} focusFallback={stripFocus} />
      : null;
    // The two keep their places whichever is there: the strip coming or
    // going must not mount the question anew.
    return strip || questionDock ? <>{strip}{questionDock}</> : null;
  }, [workers, tasks, pinned, holdTask, holdList, stripFocus, stripThreadId, isMobile, onOpenWorker, questionDock]);

  // A first page that failed: no transcript to show (an empty one would read
  // as "No messages yet"), and none is coming until asked again.
  if (loadError?.key === key && loadError.threadId === (thread?.threadId ?? null) && !thread?.loaded) {
    return (
      <ChatColumnState>
        <InlineError
          detail={loadError.message}
          onRetry={() => { setLoadError(null); setReadyKey(null); setAttempt((n) => n + 1); }}
        >
          Couldn't load the conversation.
        </InlineError>
      </ChatColumnState>
    );
  }
  // Until the first page settles: a live row that lands before it is not the
  // transcript (the history before it has not arrived).
  if (thread === null || (!ready && !thread.loaded)) {
    return <ChatColumnState><LoadingLine /></ChatColumnState>;
  }
  const wakeBusy = thread.wakePhase.phase !== "idle";
  return (
    <ShareSelectionContext.Provider value={share}>
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      <ChatMessageList
        thread={thread}
        holdKey={key}
        onLoadOlder={loadOlder}
        {...(offerReadBeside ? { offerReadBeside } : {})}
        onRetryFailed={readOnlyNote ? undefined : (id) => void retry(id)}
        onRetryWake={readOnlyNote ? undefined : (wakeId) => retryWake(scope, wakeId)}
        // A turn that stopped goes on as a message asks it to: the control's,
        // which answers none of the questions the turn had asked.
        onContinue={readOnlyNote ? undefined : () => continueTurn(scope)}
        hideQueuedPending
        emptyHelp={scope.type === "worker" || scope.type === "manager" ? scope.type : null}
        emptyState={emptyState}
        inProgressLines={voiceHere ? inProgressLines : undefined}
        onOpenWorker={onOpenWorker}
        openQuestionIds={openQuestionIds}
        newSince={newSince}
      />
      <QuestionAnnouncer questions={questions} />
      {/* Voice takes the composer's place; what stood above the composer
          (the strip, where a running task's progress is shown, and a
          question) still stands over it, on the transcript's column. */}
      {!share.selecting && (voiceHere || voiceMoved) && aboveComposer && (
        <div className={cn("flex min-h-0 flex-col px-(--chat-gutter) pb-2", CHAT_GUTTER_CLASS)}>
          <div className="mx-auto flex min-h-0 w-full flex-col" style={{ maxWidth: CHAT_COLUMN_MAX_PX }}>{aboveComposer}</div>
        </div>
      )}
      {share.selecting ? (
        <ShareSelectionBar count={share.selected.size} onCancel={share.leave} onShare={() => setShareOpen({ key, items: cardItems(share.rows(), share.selected) })} />
      ) : readOnlyNote ? (
        <div className="px-3 pb-3">
          <div data-slot="archived-note" className="mx-auto flex w-full max-w-[640px] items-center rounded-xl border border-border-soft bg-panel px-3 py-2.5 text-sm text-muted-foreground">
            {readOnlyNote}
          </div>
        </div>
      ) : voiceHere ? (
        <VoiceControlBar />
      ) : voiceMoved ? (
        <div className="px-3 pb-3">
          <div data-slot="voice-moved" className="mx-auto flex w-full max-w-[640px] items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2 text-sm text-muted-foreground">
            <span className="flex-1">Voice moved to another device.</span>
            <Button size="xs" variant="outline" onClick={resumeVoice}>Resume here</Button>
            {/* Leaves voice on this device; the other keeps its voice. */}
            <Button size="xs" variant="ghost" onClick={() => stopVoice()}>Stop</Button>
          </div>
        </div>
      ) : (
        <>
          {isPersonal && !voiceMode && stopNotice && (
            <ComposerNotice slot="voice-stopped" onDismiss={dismissStopNotice}>{stopNotice}</ComposerNotice>
          )}
          {commandNotice && <ComposerNotice slot="command-notice" onDismiss={clearCommandNotice}>{commandNotice}</ComposerNotice>}
          <ChatInput
            scope={scope}
            onSend={handleSend}
            busyHint={wakeBusy}
            onCancel={wakeBusy && thread.wakePhase.wakeId ? () => { void cancelWake(scope); } : undefined}
            queuedMessages={queuedMessages}
            onDeleteQueuedMessage={(id) => void deleteQueued(id)}
            commands={commands}
            commandState={conversationState(thread)}
            onCommand={handleCommand}
            onDraftInput={clearCommandNotice}
            mentions={mentionTarget}
            above={aboveComposer}
            textareaId={composerId}
            tools={modelTool}
          />
        </>
      )}
      {sharing && (
        <ShareDialog
          items={shareOpen.items}
          onClose={() => setShareOpen(null)}
          onDone={() => { setShareOpen(null); share.leave(); }}
        />
      )}
    </div>
    </ShareSelectionContext.Provider>
  );
}
