/** The texts a side chat's model reads, in fixed wording: change it
 *  deliberately. */

/** A side chat's first own row, after the personal agent's conversation it
 *  was forked from. */
export const SIDE_CHAT_BOUNDARY =
  "[Side chat] Everything above is your conversation with the user up to the moment this side chat opened, given only as reference. " +
  "The user opened this side chat to work out one topic with you: answer here. " +
  "Nothing from that conversation comes in here, and nothing goes back until the user sends this side chat to it. Do not continue or carry out anything asked above. " +
  "Look, don't change: read, search and run commands that change nothing; a long command moves to the background and its result comes back here. " +
  "Change files, git or anything else only when the user asks for that change in this side chat. " +
  "Tools that message threads or workers, start subagents, set alarms, ask the user, change schedules or projects, notify, or write memory are refused here, " +
  "and so are writes into your notes and page folders.";

/** A refused call's result. */
export const SIDE_CHAT_REFUSED = "Not available in a side chat: do this in the main conversation.";

/** The tools a side chat runs: the ones that read, the shell and file tools
 *  (which the boundary tells it to use for looking unless the user asks for a
 *  change here), canvases, and stopping its own background commands. What
 *  reaches into the main conversation's work (threads and workers,
 *  subagents, alarms, questions, schedules, projects, notifications) and
 *  memory writes are refused. Any tool not listed is too. */
export const SIDE_CHAT_TOOLS: ReadonlySet<string> = new Set([
  "read", "list_threads", "waiting_on_you", "read_thread", "list_projects", "list_workers", "get_worker_status",
  "read_worker_thread", "read_plan", "list_schedules", "list_my_alarms", "list_tasks", "stop_task", "chat_history_search",
  "chat_history_read", "memory_search", "memory_read", "skill", "read_skill_reference", "web_search", "web_fetch",
  "bash", "write", "edit",
  "canvas"
]);

/** What the side chat's model is asked when the user sends it to the personal
 *  agent: after the side chat's rows, for its summary. With no note the note's clauses go. */
export function sideChatHandoffRequest(note: string): string {
  const said = note.trim();
  const head = said
    ? `The user is sending this side chat to your main conversation, which has not seen it, with this note:\n${said}\n\n`
    : "The user is sending this side chat to your main conversation, which has not seen it.\n\n";
  return head +
    `Write the summary the main conversation needs to ${said ? "act on that note" : "carry the work on"}: what the user wants done, what was decided and why, what is still open, and the facts found that the work needs. ` +
    `${said ? "Keep every decision and constraint that bears on it, even ones the note does not mention;" : "Keep every decision and constraint;"} leave out what was looked at and dropped. ` +
    "Write it in the user's language, as short notes, with no greeting. The whole side chat is kept in a file the main conversation can read, so there is no need to copy it.";
}

/** What the personal agent reads of a side chat the user sent it: the summary, the
 *  file with the whole side chat, then the user's note. */
export function sideChatHandoffMessage(input: { summary: string; file: string; note: string }): string {
  const note = input.note.trim();
  return "[Side chat] The user talked this over in a side chat beside this conversation. Its summary, written there:\n\n" +
    `${input.summary}\n\nThe whole side chat: ${input.file}\n[End of side chat]` +
    (note ? `\n\n${note}` : "");
}
