import { z } from "zod";
import { STICKY_NOTE_KINDS } from "../../../../shared/api/sticky-notes.js";

/** One tool with an action. Every field but the action is optional, and a
 *  blank counts as not given: a model fills the fields it does not mean. */
export const stickyNotesParams = z.object({
  action: z.enum(["add", "update", "remove"]),
  noteId: z.string().nullable().optional().describe("For update and remove: the id add returned; the open notes are in your runtime context."),
  title: z.string().nullable().optional().describe("One line that says what happened, in the user's language."),
  body: z.string().nullable().optional().describe("A few lines in Markdown: what the user needs to know or do, and where to see it."),
  kind: z.enum(STICKY_NOTE_KINDS).nullable().optional().describe("alert: something went wrong or looks wrong, and may need them soon. check: finished work that waits for them to look at, try or accept. fyi: a result or report worth reading; nothing waits on them. later: something they must come back to at a later time, such as a deadline."),
  threadId: z.string().nullable().optional().describe("The thread the note is about, if any: the note names it."),
  taskId: z.string().nullable().optional().describe("The task the note is about, if any: the note names it."),
  reason: z.string().nullable().optional().describe("For remove: why it no longer needs the user, in a few words in their language.")
});
