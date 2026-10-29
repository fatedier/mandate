import { memo } from "react";
import { CheckCircle2 } from "lucide-react";
import type { AgentMessage } from "@/store/agent-chat";
import { AskLine } from "./AskLine";
import { askedBy, askOpenKey, askState, withdrawnBy, type QuestionMarks } from "./ask-lines";
import { CanvasReferenceCard } from "./CanvasReferenceCard";
import { MarkdownView } from "@/components/MarkdownView";
import { ToolRun } from "./ToolRun";
import type { ToolCallSpec, ToolResultSpec, ToolRunRow } from "./tool-run-summary";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import { canvasReferenceFromResult, isCanvasReferenceTool, type CanvasReference } from "./canvas-reference";
import { SubagentLine } from "./SubagentLine";
import { startedTask } from "./subagent-lines";
import { HandoffCard } from "@/routes/global/HandoffCard";
import { drawnAsHandoffCard, handoffsCalledBy, type HandoffRef } from "@/routes/global/handoff-tools";
import { cn } from "@/lib/utils";

interface AssistantMessageProps {
  message: AgentMessage;
  /** Later steps of the same wake that only called tools. Their calls join
   *  this message's in one run, so a stretch of tool work between two things
   *  the agent said reads as one line rather than one per step. */
  runTail?: AgentMessage[];
  toolResultsByCallId: Map<string, ToolResultSpec>;
  activeToolCallId: string | null;
  /** The running turn is on this row's run (liveRunRow): its line names the
   *  latest call. */
  liveRun?: boolean;
  expandedToolIds?: Set<string>;
  onToolExpandedChange?: (toolCallId: string, expanded: boolean) => void;
  /** The handoff cards this row draws: those of its turn it says something
   *  about, or its own when nothing did (turnHandoffs). Absent, the cards its
   *  own calls made. */
  handoffs?: HandoffRef[];
  /** The sentence this row's turn closed with, when the turn said nothing
   *  else and this is its last row (turnEndings): drawn as its last line. */
  closing?: string;
  /** Calls drawn as some turn's closing sentence: they leave their runs,
   *  whichever row holds them. */
  callsShownElsewhere?: ReadonlySet<string>;
  /** How the conversation's questions stand, for the lines of the ones this
   *  row asked. Absent, they read as answered. */
  questions?: QuestionMarks;
  /** When true, prefix the message with a small mic icon (voice provenance). */
  voiceMarker?: boolean;
  /** When true, render as in-progress / ephemeral (reduced opacity, pulsing dot). */
  ephemeral?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  runTail,
  toolResultsByCallId,
  activeToolCallId,
  liveRun,
  expandedToolIds,
  onToolExpandedChange,
  handoffs: placedHandoffs,
  closing,
  callsShownElsewhere,
  questions,
  voiceMarker,
  ephemeral
}: AssistantMessageProps) {
  if (message.content.type !== "assistant") return null;
  const text = message.content.text;
  const toolCallRows: ToolRunRow[] = [];
  for (const step of [message, ...(runTail ?? [])]) {
    if (step.content.type !== "assistant") continue;
    // Tools in one step run in series and nothing on the wire records when any
    // of them began — a tool message's `createdAt` is when it came back. So a
    // call's start is the completion before it: the step's own message for the
    // first, the previous result for every one after. Passing the message's
    // time to all of them, which is what this used to do, made each duration
    // the sum of every call up to that point; many calls are not the first
    // in their step.
    //
    // A gap breaks the chain on purpose. If a result never arrived, the call
    // after it has no known start, and `undefined` travels down the rest of the
    // step rather than a start we would be inventing.
    let nextToolStartedAt: string | undefined = step.createdAt;
    for (const call of (step.content.toolCalls ?? []) as ToolCallSpec[]) {
      const result = toolResultsByCallId.get(call.toolCallId) ?? null;
      const startedAt = nextToolStartedAt;
      nextToolStartedAt = result?.createdAt;
      toolCallRows.push({
        call,
        result,
        isRunning: activeToolCallId === call.toolCallId && !result,
        startedAt
      });
    }
  }
  const canvasReferences = collectCanvasReferences(toolCallRows);
  // What the global agent sent reads as a card, not as a tool line; a
  // refused call keeps its line. The cards its calls made leave the run
  // whichever row draws them.
  const called = handoffsCalledBy([message, ...(runTail ?? [])], toolResultsByCallId);
  const handoffIds = new Set(called.map((h) => h.id));
  const handoffs = placedHandoffs ?? called;
  // A question that went through is a line of its own, where it was asked;
  // one refused, or still on its way, keeps its line in the run.
  const asked = toolCallRows.flatMap((row) => {
    const question = askedBy(row.call, row.result);
    return question ? [{ callId: row.call.toolCallId, question }] : [];
  });
  const askCalls = new Set(asked.map((ask) => ask.callId));
  // Taking back a question this row asked is said by that question's line
  // (it reads "withdrawn"); in a later row the withdrawal is what its turn did.
  const askedHere = new Set(asked.map((ask) => ask.question.id));
  const saidByItsLine = (row: ToolRunRow) => {
    const questionId = withdrawnBy(row.call, row.result);
    return questionId !== null && askedHere.has(questionId);
  };
  // A background task that started (a subagent, a command in the background)
  // is a line of its own, where it started, keyed by the task its call
  // returned; one refused, or still on its way, keeps its line in the run.
  const subagents = toolCallRows.flatMap((row) => {
    const started = startedTask(row.call, row.result);
    return started ? [{ callId: row.call.toolCallId, ...started }] : [];
  });
  const subagentCalls = new Set(subagents.map((subagent) => subagent.callId));
  const runRows = toolCallRows.filter((row) =>
    !callsShownElsewhere?.has(row.call.toolCallId) && !askCalls.has(row.call.toolCallId) && !saidByItsLine(row) &&
    !subagentCalls.has(row.call.toolCallId) && !drawnAsHandoffCard(row.call, row.result, handoffIds));
  // A wake that produced no text and called no tools has nothing to say; the
  // provenance row above it (rendered by the list) is the whole record. This
  // is what used to leave a bare timestamp row under every no-op heartbeat.
  if (!text?.trim() && runRows.length === 0 && canvasReferences.length === 0 && handoffs.length === 0 && asked.length === 0 && subagents.length === 0 && !closing) return null;
  // No clock on the row: the transcript's dividers show the time where the
  // chat paused or a day began; the row's own is its frame's (RowFrame).
  return (
    <div className={cn("flex flex-col gap-1.5 text-sm leading-[1.6]", ephemeral && "opacity-70")}>
      {voiceMarker && (
        <div className="flex items-center gap-2 text-2xs text-faint">
          <VoiceMarkerHeader ephemeral={ephemeral} />
        </div>
      )}
      {text && (message.content.spokenUpdate ? (
        // Voice told the user something Mandate reported.
        <div data-slot="spoken-update" className="border-l-2 border-live pl-2.5">
          <span className="block text-2xs font-semibold text-live">Spoken update</span>
          <MarkdownView text={text} />
        </div>
      ) : <MarkdownView text={text} />)}
      {runRows.length > 0 && (
        <ToolRun
          rows={runRows}
          live={liveRun}
          expandedIds={expandedToolIds}
          onExpandedChange={onToolExpandedChange}
        />
      )}
      {subagents.map(({ callId, taskId, title, kind, type }) => (
        <SubagentLine key={callId} threadId={message.threadId} taskId={taskId} title={title} kind={kind} type={type} />
      ))}
      {canvasReferences.length > 0 && (
        <div className="flex flex-col gap-1">
          {canvasReferences.map((canvas) => (
            <CanvasReferenceCard key={canvas.canvasId} title={canvas.title} path={canvas.path} />
          ))}
        </div>
      )}
      {handoffs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {handoffs.map((h) => (
            <HandoffCard key={h.id} handoffId={h.id} fallback={h.dto} expandedIds={expandedToolIds} onExpandedChange={onToolExpandedChange} />
          ))}
        </div>
      )}
      {asked.map(({ callId, question }) => (
        <AskLine
          key={callId}
          questionId={question.id}
          question={question.question}
          state={askState(question.id, questions)}
          options={question.options}
          answer={questions?.answers?.get(question.id) ?? null}
          {...(onToolExpandedChange
            ? { expanded: expandedToolIds?.has(askOpenKey(question.id)) ?? false, onExpandedChange: (open: boolean) => onToolExpandedChange(askOpenKey(question.id), open) }
            : {})}
        />
      ))}
      {closing && (
        // The agent's own words, but not a reply to the reader: the secondary
        // colour, and no frame (nothing here asks for anything).
        <p data-slot="turn-settled" className="flex items-start gap-2 text-muted-foreground">
          <CheckCircle2 aria-hidden className="mt-[3.5px] size-[15px] shrink-0 text-faint" />
          <span className="min-w-0 break-words">{closing}</span>
        </p>
      )}
    </div>
  );
});

function collectCanvasReferences(rows: ToolRunRow[]): CanvasReference[] {
  const byId = new Map<string, CanvasReference>();
  for (const { call, result } of rows) {
    if (!isCanvasReferenceTool(call.toolName)) continue;
    if (!result || result.isError) continue;
    const canvas = canvasReferenceFromResult(result.result);
    if (canvas) byId.set(canvas.canvasId, canvas);
  }
  return [...byId.values()];
}
