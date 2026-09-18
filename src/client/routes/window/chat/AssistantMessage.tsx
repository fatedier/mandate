import { memo } from "react";
import type { AgentMessage } from "@/store/agent-chat";
import { CanvasReferenceCard } from "./CanvasReferenceCard";
import { LazyMarkdownView } from "@/components/LazyMarkdownView";
import { ToolCallCard, type ToolCallSpec, type ToolResultSpec } from "./ToolCallCard";
import { VoiceMarkerHeader } from "./VoiceMarkerHeader";
import { canvasReferenceFromResult, isCanvasReferenceTool, type CanvasReference } from "./canvas-reference";
import { formatClockTime, formatDateTimeTitle } from "@/lib/format";
import { cn } from "@/lib/utils";

interface AssistantMessageProps {
  message: AgentMessage;
  toolResultsByCallId: Map<string, ToolResultSpec>;
  activeToolCallId: string | null;
  expandedToolIds?: Set<string>;
  onToolExpandedChange?: (toolCallId: string, expanded: boolean) => void;
  /** When true, prefix the message with a small mic icon (voice provenance). */
  voiceMarker?: boolean;
  /** When true, omit the clock row: the caller already shows this message's
   *  time (the wake-provenance row is built from the same createdAt). */
  hideClock?: boolean;
  /** When true, render as in-progress / ephemeral (reduced opacity, pulsing dot). */
  ephemeral?: boolean;
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  toolResultsByCallId,
  activeToolCallId,
  expandedToolIds,
  onToolExpandedChange,
  voiceMarker,
  hideClock = false,
  ephemeral
}: AssistantMessageProps) {
  if (message.content.type !== "assistant") return null;
  const text = message.content.text;
  const toolCalls = (message.content.toolCalls ?? []) as ToolCallSpec[];
  const canvasReferences = collectCanvasReferences(toolCalls, toolResultsByCallId);
  // A wake that produced no text and called no tools has nothing to say; the
  // provenance row above it (rendered by the list) is the whole record. This
  // is what used to leave a bare timestamp row under every no-op heartbeat.
  if (!text?.trim() && toolCalls.length === 0 && canvasReferences.length === 0) return null;
  const messageTime = hideClock ? "" : formatClockTime(message.createdAt);
  // Tools in one step run in series and nothing on the wire records when any of
  // them began — a tool message's `createdAt` is when it came back. So a call's
  // start is the completion before it: the assistant message for the first,
  // the previous result for every one after. Passing `message.createdAt` to all
  // of them, which is what this used to do, made each duration the sum of every
  // call up to that point; 23.8% of calls are not the first in their step.
  //
  // A gap breaks the chain on purpose. If a result never arrived, the call
  // after it has no known start, and `undefined` travels down the rest of the
  // step rather than a start we would be inventing.
  let nextToolStartedAt: string | undefined = message.createdAt;
  const toolCallRows = toolCalls.map((call) => {
    const result = toolResultsByCallId.get(call.toolCallId) ?? null;
    const startedAt = nextToolStartedAt;
    nextToolStartedAt = result?.createdAt;
    return { call, result, startedAt };
  });

  return (
    <div className={cn("flex flex-col gap-1.5 text-sm leading-[1.6]", ephemeral && "opacity-70")}>
      {(voiceMarker || messageTime) && (
        <div className="flex items-center gap-2 text-2xs text-faint">
          {voiceMarker && <VoiceMarkerHeader ephemeral={ephemeral} />}
          {messageTime && (
            <time
              data-slot="assistant-clock"
              className="tabular-nums"
              dateTime={message.createdAt}
              title={formatDateTimeTitle(message.createdAt)}
            >
              {messageTime}
            </time>
          )}
        </div>
      )}
      {text && <LazyMarkdownView text={text} />}
      {toolCalls.length > 0 && (
        <div className="flex flex-col gap-1">
          {toolCallRows.map(({ call, result, startedAt }) => (
            <ToolCallCard
              key={call.toolCallId}
              call={call}
              result={result}
              isRunning={activeToolCallId === call.toolCallId && !result}
              startedAt={startedAt}
              expanded={expandedToolIds?.has(call.toolCallId)}
              onExpandedChange={(expanded) => onToolExpandedChange?.(call.toolCallId, expanded)}
            />
          ))}
        </div>
      )}
      {canvasReferences.length > 0 && (
        <div className="flex flex-col gap-1">
          {canvasReferences.map((canvas) => (
            <CanvasReferenceCard key={canvas.canvasId} title={canvas.title} path={canvas.path} />
          ))}
        </div>
      )}
    </div>
  );
});

function collectCanvasReferences(
  toolCalls: ToolCallSpec[],
  toolResultsByCallId: Map<string, ToolResultSpec>
): CanvasReference[] {
  const byId = new Map<string, CanvasReference>();
  for (const call of toolCalls) {
    if (!isCanvasReferenceTool(call.toolName)) continue;
    const result = toolResultsByCallId.get(call.toolCallId);
    if (!result || result.isError) continue;
    const canvas = canvasReferenceFromResult(result.result);
    if (canvas) byId.set(canvas.canvasId, canvas);
  }
  return [...byId.values()];
}
