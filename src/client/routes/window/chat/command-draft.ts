import type { AgentCommandDto, AgentCommandState } from "@shared/api-contracts";
import type { ThreadState } from "@/store/agent-chat";
import { composerOptionId } from "./composer-option-id";

/** What the conversation is doing, as a command sees it (the server's three
 *  states): a wake in flight is a turn, whatever it is doing; a compaction
 *  with no wake was started by hand. */
export function conversationState(
  thread: Pick<ThreadState, "wakePhase" | "compressionPhase"> | null | undefined
): AgentCommandState {
  if (!thread) return "idle";
  if (thread.wakePhase.phase !== "idle") return "running";
  return thread.compressionPhase ? "compacting" : "idle";
}

/** The commands the list shows for a draft: those whose name starts with
 *  the whole draft, once it has its slash. So a path ("/tmp/foo") opens
 *  nothing, and the list goes at the first space: no name holds one. */
export function commandMatches(draft: string, commands: readonly AgentCommandDto[]): AgentCommandDto[] {
  return draft.startsWith("/") ? commands.filter((command) => command.name.startsWith(draft)) : [];
}

/** The command a draft names: its first word, exactly. The server decides
 *  the same way; this only picks which route the draft goes to. */
export function commandOfDraft(draft: string, commands: readonly AgentCommandDto[]): AgentCommandDto | null {
  const first = draft.trim().split(/\s+/, 1)[0] ?? "";
  return commands.find((command) => command.name === first) ?? null;
}

/** A row's id in the list, for the textarea's aria-activedescendant. */
export const commandOptionId = (listId: string, name: string) => composerOptionId(listId, name.slice(1));
