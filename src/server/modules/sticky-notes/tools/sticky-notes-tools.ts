import type { z } from "zod";
import type { ToolDefinition } from "../../agent/tool-registry.js";
import type { AgentStore } from "../../agent/agent-store.js";
import type { TaskBoardService } from "../../task-board/task-board-service.js";
import { localTimeZone } from "../../../platform/time/agent-time.js";
import { NO_OPEN_NOTE, NOTE_INCOMPLETE, StickyNoteRefusal, type StickyNoteInput, type StickyNotesService } from "../sticky-notes-service.js";
import { renderStickyNoteLine, type StickyNoteTextClock } from "../sticky-notes-text.js";
import { stickyNotesParams } from "./sticky-notes-tools-schema.js";

const DESCRIPTION = [
  "Sticky notes on the user's Notes page: what they must not miss or may want to come back to while you are not waiting on their answer. A note stays until the user marks it done or you remove it. Actions:",
  "- add: a new note (title, body, kind, and the thread or task it is about). Returns its id.",
  "- update: change an open note of yours; what you give replaces that field, and it shows as updated and new to the user again.",
  "- remove: take an open note off when it no longer needs the user, with `reason`, which they see."
].join("\n");

const noSuchThread = (id: string) => `No such thread: ${id}.`;
const noSuchTask = (id: string) => `No such task: ${id}.`;

/** A value the model gave, or undefined for a blank or null one. */
const given = (value: string | null | undefined): string | undefined => (value?.trim() ? value.trim() : undefined);

export interface StickyNotesToolDeps {
  stickyNotes: StickyNotesService;
  agentStore: Pick<AgentStore, "getThreadById">;
  taskBoard?: Pick<TaskBoardService, "detail">;
  timeZone?: () => string;
  now?: () => number;
}

/** The personal agent's one tool for its sticky notes: no thread or worker has it. */
export function buildStickyNotesTools(deps: StickyNotesToolDeps): ToolDefinition[] {
  const clock = (): StickyNoteTextClock => ({ timeZone: deps.timeZone?.() ?? localTimeZone(), now: deps.now?.() ?? Date.now() });
  const notes = deps.stickyNotes;

  /** What the note is about, checked: a manager thread, or a task not deleted. */
  const about = (threadId: string | undefined, taskId: string | undefined): Pick<StickyNoteInput, "threadId" | "taskId" | "aboutTitle"> | null => {
    if (threadId) {
      const thread = deps.agentStore.getThreadById(threadId);
      if (!thread || thread.scope !== "manager") throw new StickyNoteRefusal(noSuchThread(threadId), 404);
      return { threadId, aboutTitle: notes.aboutTitle({ kind: "thread", id: threadId }) };
    }
    if (taskId) {
      const task = deps.taskBoard?.detail(taskId);
      if (!task || task.deletedAt) throw new StickyNoteRefusal(noSuchTask(taskId), 404);
      return { taskId, aboutTitle: task.title };
    }
    return null;
  };

  const tool: ToolDefinition<z.infer<typeof stickyNotesParams>, unknown> = {
    name: "sticky_notes",
    description: DESCRIPTION,
    parameters: stickyNotesParams,
    handler: async (args) => {
      try {
        switch (args.action) {
          case "add": {
            const title = given(args.title);
            const body = given(args.body);
            if (!title || !body || !args.kind) return { error: NOTE_INCOMPLETE };
            const note = notes.add({ title, body, kind: args.kind, ...about(given(args.threadId), given(args.taskId)) });
            return renderStickyNoteLine(note, clock());
          }
          case "update": {
            const id = given(args.noteId);
            // Not open (done, removed, unknown): said first, whatever else the call names.
            const held = id ? notes.get(id) : null;
            if (!id || !held || held.doneAt) return { error: NO_OPEN_NOTE };
            // The note's own subject named again is no change: it stands though
            // that thread or task is gone since (a model re-sends what it wrote).
            const own = held.about?.id;
            const threadId = given(args.threadId);
            const taskId = given(args.taskId);
            const subject = (threadId ?? taskId) === own ? null : about(threadId, taskId);
            const change: Partial<StickyNoteInput> = { ...subject };
            const title = given(args.title);
            const body = given(args.body);
            if (title) change.title = title;
            if (body) change.body = body;
            if (args.kind) change.kind = args.kind;
            return renderStickyNoteLine(notes.update(id, change), clock());
          }
          case "remove": {
            const id = given(args.noteId);
            if (!id) return { error: NO_OPEN_NOTE };
            return renderStickyNoteLine(notes.remove(id, args.reason ?? ""), clock());
          }
        }
      } catch (err) {
        if (err instanceof StickyNoteRefusal) return { error: err.message };
        throw err;
      }
    }
  };
  return [tool as ToolDefinition];
}
