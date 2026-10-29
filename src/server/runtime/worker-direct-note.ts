import type { AgentMessage, AgentStore } from "../modules/agent/agent-store.js";
import type { FeaturesStore } from "../modules/features/features-store.js";
import type { UpwardInbox } from "../modules/agent/upward-inbox.js";
import { cutKeepingWhole } from "../modules/agent/tool-output-spool.js";
import { featureMessageNoteMetadata } from "../../shared/feature-message.js";

/** Past this the note carries the start of what the user wrote. */
const NOTE_TEXT_MAX = 4000;

interface WorkerDirectNoteDeps {
  agentStore: Pick<AgentStore, "getThreadById">;
  featuresStore: Pick<FeaturesStore, "getById">;
  /** Where the note goes in: a note wakes nobody. */
  inbox: Pick<UpwardInbox, "post">;
}

function noteText(input: { workerName: string; text: string; attachments: number; viaAgent: boolean }): string {
  const who = input.viaAgent ? "The user, through their agent," : "The user";
  const left = input.attachments > 0
    ? ` (with ${input.attachments} attachment${input.attachments === 1 ? "" : "s"}, not forwarded)`
    : "";
  return `${who} wrote to your worker "${input.workerName}" directly; the worker has the message${left}:\n\n`
    + `${input.text}\n\nNo reply is needed. Take it into account when you next direct this worker.`;
}

/**
 * What the user tells a worker directly, copied to the worker's manager.
 * The manager directs the worker; without this it went on
 * with what the user changed unknown to it. Called as each message lands in
 * a conversation, so only what the worker really has is told: a queued
 * message withdrawn never is. A note, not a request: it wakes nobody, and
 * answers none of the questions the manager asked the user. With the manager
 * idle it lands now, so the user sees it in the manager's conversation;
 * mid-turn it waits in the manager's mailbox for its next step, never between
 * a tool call and its result.
 */
export function noteWorkerMessageToManager(deps: WorkerDirectNoteDeps, threadId: string, message: AgentMessage): void {
  if (message.role !== "user" || message.source !== "user" || message.content.type !== "text") return;
  const thread = deps.agentStore.getThreadById(threadId);
  if (thread?.scope !== "worker" || !thread.scopeId) return;
  const feature = deps.featuresStore.getById(thread.scopeId);
  if (!feature || feature.archivedAt || !feature.ownerThreadId) return;
  const manager = deps.agentStore.getThreadById(feature.ownerThreadId);
  if (!manager || manager.scope !== "manager" || manager.archivedAt) return;

  const said = message.content.text.trim();
  const text = said.length > NOTE_TEXT_MAX ? `${said.slice(0, NOTE_TEXT_MAX)}…` : said;
  const attachments = message.content.attachments?.length ?? 0;
  const viaAgent = message.content.relay?.by === "global";
  const content = {
    type: "text" as const,
    // The manager's model gets the one cut, the whole saved where it can read
    // it; the card keeps its own.
    text: noteText({ workerName: feature.name, text: cutKeepingWhole(said, NOTE_TEXT_MAX, { threadId: manager.id }), attachments, viaAgent }),
    metadata: featureMessageNoteMetadata({ featureId: feature.id, featureName: feature.name, by: viaAgent ? "agent" : "user", text, attachments })
  };
  deps.inbox.post({ to: manager.id, kind: "note", key: `feature:${feature.id}`, source: "feature-message", sourceThreadId: threadId, content });
}
