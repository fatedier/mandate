import * as fs from "node:fs";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import { threadNotesDir } from "../../platform/fs/resources.js";
import { readNotesIndex, renderNotesIndex } from "../personal/personal-context.js";
import type { AgentStore } from "./agent-store.js";
import threadNotesTemplatePath from "./prompts/thread-notes.md" with { type: "file" };

/** Compactions after which a manager thread keeps notes: by then each
 *  summary has been summarised again, and what the thread decided thins out. */
export const THREAD_NOTES_AT = 3;

/** What the manager scope asks about a thread that is not on duty. */
export interface ThreadNotes {
  /** Its notes block for the runtime context; null until it keeps notes. */
  context(threadId: string): string | null;
}

export function createThreadNotes(deps: { agentStore: Pick<AgentStore, "hasCompactions">; dataDir?: string }): ThreadNotes {
  return {
    context(threadId) {
      const notesDir = threadNotesDir(threadId, deps.dataDir);
      const index = readNotesIndex(notesDir);
      // Notes once written stay shown; before that, only a thread compacted enough.
      if (index === null && !deps.agentStore.hasCompactions(threadId, THREAD_NOTES_AT)) return null;
      fs.mkdirSync(notesDir, { recursive: true });
      return renderPromptFile(threadNotesTemplatePath, { notesDir, notesIndex: renderNotesIndex(index) });
    }
  };
}
