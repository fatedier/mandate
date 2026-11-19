import { memo } from "react";
import { CheckCircle2, CircleSlash, Send } from "lucide-react";
import type { AgentMessage } from "@/store/agent-chat";
import { AskLine } from "./AskLine";
import { askedBy, askOpenKey, askState, withdrawnBy, type QuestionMarks } from "./ask-lines";
import { CanvasReferenceLink } from "./CanvasReferenceLink";
import { MarkdownView } from "@/components/MarkdownView";
import { ToolRun } from "./ToolRun";
import type { ToolCallSpec, ToolResultSpec, ToolRunRow } from "./tool-run-summary";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import { canvasReferenceFromResult, isCanvasReferenceCall, type CanvasReference } from "./canvas-reference";
import { StartedTaskLines } from "./SubagentLine";
import { startedTask } from "./subagent-lines";
import { HandoffCard } from "@/routes/personal/HandoffCard";
import { drawnAsHandoffCard, handoffsCalledBy } from "@/routes/personal/handoff-tools";
import { cn } from "@/lib/utils";

/** A duty thread's word for "nothing for the personal agent" (duty-reports.ts). */
const NO_REPORT = "NO_REPORT";

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
  /** A duty thread's reply: whether it went to the personal agent as the report
   *  ("sent"), or was kept back with NO_REPORT; `to` names who. */
  dutyMark?: { outcome: "sent" | "no_report"; to: string };
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  runTail,
  toolResultsByCallId,
  activeToolCallId,
  liveRun,
  expandedToolIds,
  onToolExpandedChange,
  closing,
  callsShownElsewhere,
  questions,
  voiceMarker,
  ephemeral,
  dutyMark
}: AssistantMessageProps) {
  if (message.content.type !== "assistant") return null;
  // A reply kept back says so in its mark: the bare word is not drawn too.
  const text = dutyMark?.outcome === "no_report" && message.content.text?.trim() === NO_REPORT ? "" : message.content.text;
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
  // What the personal agent sent reads as a card, not as a tool line, under
  // the run that sent it (a step that sent one ends its run: groupToolRuns);
  // a refused call keeps its line.
  const handoffs = handoffsCalledBy([message, ...(runTail ?? [])], toolResultsByCallId);
  const handoffIds = new Set(handoffs.map((h) => h.id));
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
  // is a line out of its run, where it started, keyed by the task its call
  // returned (StartedTaskLines); one refused, or still on its way, keeps its
  // line in the run.
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
  // is what used to leave a bare timestamp row under every no-op sweep.
  if (!text?.trim() && runRows.length === 0 && canvasReferences.length === 0 && handoffs.length === 0 && asked.length === 0 && subagents.length === 0 && !closing && !dutyMark) return null;
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
      {/* Above the run: its line stays last, next to what the turn is doing now. */}
      {subagents.length > 0 && (
        <StartedTaskLines threadId={message.threadId} lines={subagents} expandedIds={expandedToolIds} onExpandedChange={onToolExpandedChange} />
      )}
      {runRows.length > 0 && (
        <ToolRun
          rows={runRows}
          live={liveRun}
          expandedIds={expandedToolIds}
          onExpandedChange={onToolExpandedChange}
        />
      )}
      {canvasReferences.length > 0 && (
        <div className="flex flex-col gap-1">
          {canvasReferences.map((canvas) => (
            <CanvasReferenceLink key={canvas.canvasId} title={canvas.title} path={canvas.path} />
          ))}
        </div>
      )}
      {handoffs.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {handoffs.map((h) => (
            <HandoffCard key={h.id} handoffId={h.id} fallback={h.dto} taskId={h.taskId} />
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
      {dutyMark && (
        // What became of the reply, not a word of the agent's: small and quiet.
        <p data-slot="duty-report-mark" data-outcome={dutyMark.outcome} className="flex items-center gap-1.5 text-2xs text-faint">
          {dutyMark.outcome === "sent"
            ? <Send aria-hidden className="size-3 shrink-0" />
            : <CircleSlash aria-hidden className="size-3 shrink-0" />}
          <span className="min-w-0 break-words">
            {dutyMark.outcome === "sent" ? `Sent to ${dutyMark.to} as the report` : `${NO_REPORT} · not sent to ${dutyMark.to}`}
          </span>
        </p>
      )}
    </div>
  );
});

function collectCanvasReferences(rows: ToolRunRow[]): CanvasReference[] {
  const byId = new Map<string, CanvasReference>();
  for (const { call, result } of rows) {
    if (!isCanvasReferenceCall(call)) continue;
    if (!result || result.isError) continue;
    const canvas = canvasReferenceFromResult(result.result);
    if (canvas) byId.set(canvas.canvasId, canvas);
  }
  return [...byId.values()];
}
