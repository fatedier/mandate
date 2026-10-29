import type { AgentStore } from "../agent/agent-store.js";
import type { AgentSseEmitter } from "../sse/sse-events.js";
import type { PageStore } from "./page-store.js";
import { SSE_EVENTS } from "../../../shared/api-contracts.js";
import type { AgentPageAnswerDto } from "../../../shared/api/agent-page.js";

/** How many answers the page's answers source lists, newest first. */
export const PAGE_ANSWERS_LISTED = 50;

/** HH:MM on the machine's clock, which is the user's: Mandate runs on it. */
export function pageClock(iso: string): string {
  const at = new Date(iso);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

export interface PageAnswersDeps {
  store: Pick<PageStore, "addAnswer" | "answers" | "markDelivered" | "transaction" | "unreadAnswers">;
  agentStore: Pick<AgentStore, "getOrCreateGlobalThread" | "enqueueMailboxMessage">;
  sse: Pick<AgentSseEmitter, "emit">;
}

/**
 * What the user gives on the page. Kept, and handed to Your agent as a
 * quiet note it reads on its next turn: nobody is woken, and the chat shows
 * nothing. Read once its note reached Your agent.
 */
export class PageAnswers {
  constructor(private readonly deps: PageAnswersDeps) {}

  /** Answers waiting for Your agent: a page may add more only below the limit. */
  unread(): number {
    return this.deps.store.unreadAnswers();
  }

  add(value: unknown): AgentPageAnswerDto {
    const thread = this.deps.agentStore.getOrCreateGlobalThread();
    const at = new Date().toISOString();
    // Its note and its row are one write: never one without the other.
    const answer = this.deps.store.transaction(() => {
      const note = this.deps.agentStore.enqueueMailboxMessage({
        threadId: thread.id,
        role: "user",
        source: "page-input",
        content: { type: "text", text: `[Page answer, ${pageClock(at)}] ${JSON.stringify(value)}` },
        triggerTurn: false
      });
      return this.deps.store.addAnswer(value, note.id, at);
    });
    this.deps.sse.emit(SSE_EVENTS.agentPageAnswer, { answer });
    return answer;
  }

  list(limit: number): AgentPageAnswerDto[] {
    return this.deps.store.answers(limit);
  }

  /** Their notes reached Your agent: read. The ones read now, for announce
   *  once the write that took the notes in is committed. */
  markDelivered(mailboxIds: readonly string[]): AgentPageAnswerDto[] {
    return this.deps.store.markDelivered(mailboxIds);
  }

  /** The page hears these answers were read. */
  announce(answers: readonly AgentPageAnswerDto[]): void {
    for (const answer of answers) this.deps.sse.emit(SSE_EVENTS.agentPageAnswer, { answer });
  }
}
