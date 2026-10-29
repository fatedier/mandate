import { formatDateTime, formatDuration } from "@/lib/format";
import { summarizeArgs } from "./tool-args-summary";
import { canvasReferenceFromResult, isCanvasReferenceTool } from "./canvas-reference";
import { keyPresses, pressesText } from "./tool-details/keys";
import { BASH_EXIT_LINE, editArgs, editResult, writeArgs, writeResult } from "./tool-details/parse";
import type { LineChanges } from "@shared/line-diff";
import { parseFetchText, parseSearchText } from "@shared/web-tool-text";

/** How a run of tool calls reads in the transcript: one line in words, the
 *  way a person would say what happened ("Ran 3 commands, edited 2 files"),
 *  with the calls themselves one tap away. Pure, so the wording is tested
 *  without rendering. */

export interface ToolCallSpec {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultSpec {
  result?: unknown;
  isError?: boolean;
  error?: string;
  createdAt?: string;
}

/** One call as the transcript knows it. */
export interface ToolRunRow {
  call: ToolCallSpec;
  result: ToolResultSpec | null;
  isRunning: boolean;
  /** When it began, derived by the caller from the completion before it;
   *  absent when that could not be known. */
  startedAt?: string;
}

type ToolRowStatus = "running" | "error" | "ok" | "pending";

/** The open-state key a run is marked with, one per call. A run is open when
 *  any of its calls carries the mark, so the mark survives the run gaining an
 *  earlier step — loading older messages can join one onto its front — where
 *  a key taken from the run's first message would change under it. */
export function runOpenKey(toolCallId: string): string {
  return `run:${toolCallId}`;
}

export function rowStatus(row: ToolRunRow): ToolRowStatus {
  if (row.isRunning) return "running";
  if (row.result?.isError || reportedError(row.result) || commandFailed(row)) return "error";
  return row.result ? "ok" : "pending";
}

/** Commands for which exit status 1 is an answer rather than a failure: grep
 *  and rg found nothing, diff and cmp found a difference, test was false. Two
 *  and up is still a failure for them: `false` (1) and grep on a missing
 *  file (2) are errors, grep with no match (1) and diff of two differing
 *  files (1) are not. */
const EXIT_ONE_IS_AN_ANSWER = new Set(["grep", "egrep", "fgrep", "rg", "diff", "cmp", "test", "["]);

/** The exit code a bash call reported. */
function bashExitCode(result: ToolResultSpec | null): number | null {
  const value = result?.result;
  if (typeof value !== "string") return null;
  const match = BASH_EXIT_LINE.exec(value);
  return match ? Number(match[1]) : null;
}

/** The program whose exit status is the whole line's, when that can be known:
 *  a single pipeline reports its last stage's status, so that stage's program
 *  (past variable assignments, by base name). A list — `&&`, `||`, `;`, a new
 *  line — can end on any of its commands' status: `cd /missing && rg x .`
 *  exits with cd's 1 before rg runs. So a list names no program, and its
 *  non-zero exit stays a failure; a missed failure is worse than a grep that
 *  found nothing drawn in red. Quoted text is set aside first, so a `|` or
 *  `&&` inside a pattern splits nothing, and trailing `;` are dropped. */
export function answeringProgram(command: string): string | null {
  const unquoted = command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''")
    .trim()
    .replace(/[;\s]+$/, "");
  if (/&&|\|\||;|\n/.test(unquoted)) return null;
  const stage = unquoted.split("|").at(-1)?.trim() ?? "";
  const word = stage.split(/\s+/).find((w) => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return word ? word.slice(word.lastIndexOf("/") + 1) : null;
}

/** A bash call whose command exited non-zero, bar the answers above. */
function commandFailed(row: ToolRunRow): boolean {
  if (row.call.toolName !== "bash") return false;
  const code = bashExitCode(row.result);
  if (code === null || code === 0) return false;
  const program = answeringProgram(stringArg(row.call.args, "command") ?? "");
  return !(code === 1 && program !== null && EXIT_ONE_IS_AN_ANSWER.has(program));
}

/** A bash call's non-zero exit in the fewest words, "exit 2", said whether
 *  or not it counts as a failure: `test -f x` exiting 1 is no failure, but it
 *  is the answer. Null for any other call. */
export function bashExitNote(row: ToolRunRow): string | null {
  if (row.call.toolName !== "bash") return null;
  const code = bashExitCode(row.result);
  if (code === null || code === 0) return null;
  return `exit ${code}`;
}

/** What a web call came back with, in the fewest words: how many results a
 *  search found, how much of a page was read. Null for any other call, a
 *  failed one (the run says it failed) and a result in no shape the formatter
 *  writes (one shortened by retention). */
export function callNote(row: ToolRunRow): string | null {
  const text = row.result && !row.result.isError && typeof row.result.result === "string" ? row.result.result : null;
  if (text === null) return null;
  const count = (n: number) => n.toLocaleString("en-US");
  if (row.call.toolName === "web_search") {
    const parsed = parseSearchText(text);
    if (parsed === null) return null;
    const n = parsed === "nothing" ? 0 : parsed.results.length;
    // An answer that named no pages is not nothing.
    if (n === 0 && parsed !== "nothing" && parsed.answer) return "answer only";
    return n === 1 ? "1 result" : `${count(n)} results`;
  }
  if (row.call.toolName === "web_fetch") {
    const page = parseFetchText(text);
    if (!page) return null;
    const whole = page.start === 0 && page.end === page.length;
    return whole ? `${count(page.length)} chars` : `${count(page.end - page.start)} of ${count(page.length)} chars`;
  }
  return null;
}

/** A failure the tool reported in its result instead of raising one — send_keys
 *  answers a stale pane with `{ error: "…" }` — so the call is not flagged
 *  isError. An `error` beside `ok: true` is a note on a success. (A command's
 *  exit status is read separately, by `commandFailed`.) */
function reportedError(result: ToolResultSpec | null): string | null {
  const value = result?.result;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.ok === true) return null;
  return typeof record.error === "string" && record.error.trim() ? record.error : null;
}

/** What one call did, in words: a verb and what it acted on. */
export interface CallPhrase {
  /** The verb, or the tool's own name for a tool with no wording here. */
  lead: string;
  leadIsToolName: boolean;
  /** What it acted on — a model-written description, a file, a command. */
  detail: string;
  detailIsCode: boolean;
}

/** Tools whose `description` argument is the model saying what the call is
 *  for, written to be shown here. Only these: another tool may have a
 *  parameter called `description` that means something else entirely (a
 *  memory query, say), and showing that as the call's purpose would be wrong. */
const DESCRIBED_TOOLS = new Set(["bash", "send_keys"]);

export function callDescription(call: ToolCallSpec): string | null {
  // A command monitor's sits beside the command it describes, as bash's does.
  if (call.toolName === "monitor") return stringArg(objectArg(call.args, "command"), "description");
  if (!DESCRIBED_TOOLS.has(call.toolName)) return null;
  return stringArg(call.args, "description");
}

/** The title a canvas call reports in its own result: the name the canvas had
 *  when this ran, not whatever it is called today. Nothing for a call that
 *  failed, even if its payload still looks like a success. */
function canvasTitleOf(row: Pick<ToolRunRow, "call" | "result">): string | null {
  if (row.result?.isError || !isCanvasReferenceTool(row.call.toolName)) return null;
  return canvasReferenceFromResult(row.result?.result)?.title ?? null;
}

/** What the transcript called the panes and features calls name by id
 *  (tool-details/names.ts); a pane's name is looked up through the call that
 *  acted on it. Without it, ids show as themselves. */
export interface CallNames {
  pane(callId: string): string | null;
  feature(id: string): string | null;
  canvas(id: string): string | null;
  /** For a read of a saved tool output, the call that output came from. */
  savedOutput(callId: string): ToolRunRow | null;
  /** The thread still waits on this monitor: its row reads in the present. */
  monitorPending?(monitorId: string): boolean;
}

/** A result's fields, for a call that came back without raising. */
function resultRecord(row: ToolRunRow): Record<string, unknown> | null {
  const value = row.result && !row.result.isError ? row.result.result : null;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function resultString(row: ToolRunRow, key: string): string | null {
  const value = resultRecord(row)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A page's address as a row shows it: host, path and query, no scheme or
 *  fragment; the text as given when it is not an address. */
export function hostAndPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === "/" && !parsed.search ? "" : parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

export function describeCall(row: ToolRunRow, names?: CallNames): CallPhrase {
  const { call } = row;
  const running = rowStatus(row) === "running";
  const verb = (done: string, active: string) => (running ? active : done);
  const words = (lead: string, detail: string, detailIsCode: boolean): CallPhrase =>
    ({ lead, leadIsToolName: false, detail, detailIsCode });
  const description = callDescription(call);
  // A pane or feature by the name the transcript gave it, else its id.
  const pane = (lead: string): CallPhrase => {
    const name = names?.pane(call.toolCallId) ?? null;
    return name ? words(lead, name, false) : words(lead, stringArg(call.args, "paneId") ?? "", true);
  };
  // Ids are looked up exactly as written: the server matched them exactly.
  const feature = (lead: string, key = "featureId"): CallPhrase => {
    const id = exactArg(call.args, key);
    const name = id ? names?.feature(id) ?? null : null;
    return name ? words(lead, name, false) : words(lead, id ?? "", true);
  };
  const text = (lead: string, key: string): CallPhrase => words(lead, stringArg(call.args, key) ?? "", false);
  // A canvas by the title the transcript gave it; its id alone says nothing.
  const canvas = (): string | null => {
    const id = exactArg(call.args, "canvasId");
    return id ? names?.canvas(id) ?? null : null;
  };
  const code = (lead: string, key: string): CallPhrase => words(lead, stringArg(call.args, key) ?? "", true);

  switch (call.toolName) {
    case "bash": {
      const lead = verb("Ran", "Running");
      return description
        ? words(lead, description, false)
        : words(lead, stringArg(call.args, "command") ?? "", true);
    }
    case "send_keys": {
      const lead = verb("Sent keys", "Sending keys");
      if (description) return words(lead, description, false);
      // Without one, what was typed and pressed, as tmux reads the args
      // (`-l` is how, not what); args in a form not read, as sent.
      const keys = recordArg(call.args, "args");
      const strings = Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : [];
      const presses = keyPresses(strings);
      return words(lead, presses ? pressesText(presses) : strings.join(" "), true);
    }
    case "read": {
      // A tool's output too large to hand back whole is saved to a file named
      // by a random id: said as whose output it is, as that call's own line
      // says it, and not by the id.
      const source = names?.savedOutput(call.toolCallId) ?? null;
      if (source || isSavedOutputPath(recordArg(call.args, "path"))) {
        const lead = verb("Read saved output", "Reading saved output");
        // One step back and no further: a source that is itself a read of
        // a saved output says only that, whatever the transcript links.
        const of = source && names ? describeCall(source, { ...names, savedOutput: () => null }) : null;
        return of?.detail ? words(`${lead} of`, of.detail, of.detailIsCode) : words(lead, "", false);
      }
      return words(verb("Read", "Reading"), fileName(call.args), true);
    }
    case "edit":
      return words(verb("Edited", "Editing"), fileName(call.args), true);
    case "write":
      return words(createdFile(row) ? "Created" : verb("Wrote", "Writing"), fileName(call.args), true);
    case "view_image":
      return words(verb("Viewed", "Viewing"), fileName(call.args), true);
    case "read_pane":
      return pane(verb("Read", "Reading"));
    case "monitor": {
      const command = objectArg(call.args, "command");
      // It goes on after the call: in the present while the thread still
      // waits on it, in the past once it fired, timed out or was cancelled.
      const monitorId = resultString(row, "monitorId");
      const waiting = running || (monitorId !== null && (names?.monitorPending?.(monitorId) ?? false));
      const tense = (ended: string, ongoing: string) => (waiting ? ongoing : ended);
      if (!command) {
        // A pane, as a watch named it: by the name the transcript gave it.
        const name = names?.pane(call.toolCallId) ?? null;
        const lead = tense("Watched", "Watching");
        return name ? words(lead, name, false) : words(lead, stringArg(objectArg(call.args, "pane"), "paneId") ?? "", true);
      }
      // One whose condition already held registered nothing.
      const lead = resultString(row, "status") === "already_satisfied" ? "Checked" : tense("Monitored", "Monitoring");
      return description ? words(lead, description, false) : words(lead, stringArg(command, "run") ?? "", true);
    }
    case "spawn_pane": {
      // Its own name, else the id it came back with.
      const lead = verb("Opened pane", "Opening pane");
      const name = stringArg(call.args, "name");
      if (name) return words(lead, name, false);
      const id = resultString(row, "paneId");
      return id ? words(lead, id, true) : words(verb("Opened a pane", "Opening a pane"), "", false);
    }
    case "kill_pane":
      return pane(verb("Closed", "Closing"));
    case "set_pane_metadata": {
      // What it changed: the name (to what), or only the description.
      const args = call.args;
      if (!recordHas(args, "name")) return pane(verb("Described", "Describing"));
      const name = stringArg(args, "name");
      return name ? words(verb("Renamed a pane to", "Renaming a pane to"), name, false) : pane(verb("Cleared the name of", "Clearing the name of"));
    }
    case "pane_status":
      return pane(verb("Checked", "Checking"));
    case "list_panes":
      return words(verb("Listed panes", "Listing panes"), "", false);
    case "skill":
      return code(verb("Loaded skill", "Loading skill"), "name");
    case "read_skill_reference":
      return code(verb("Read skill reference", "Reading skill reference"), "path");
    case "memory_search":
      return text(verb("Searched memory for", "Searching memory for"), "query");
    case "web_search":
      return text(verb("Searched the web for", "Searching the web for"), "query");
    case "web_fetch":
      return words(verb("Fetched", "Fetching"), hostAndPath(stringArg(call.args, "url") ?? ""), true);
    case "memory_remember":
      return text(verb("Remembered", "Remembering"), "content");
    case "memory_update":
      return text(verb("Updated a memory", "Updating a memory"), "content");
    case "memory_read": {
      const target = stringArg(call.args, "target");
      if (target === "project") return text(verb("Read the memory of", "Reading the memory of"), "project");
      return target === "user"
        ? words(verb("Read the user brief", "Reading the user brief"), "", false)
        : words(verb("Read a memory", "Reading a memory"), "", false);
    }
    case "memory_forget":
      return words(verb("Forgot a memory", "Forgetting a memory"), "", false);
    case "update_plan":
      return words(verb("Updated the plan", "Updating the plan"), "", false);
    case "read_plan":
      // The manager names a feature; the worker reads its own.
      return stringArg(call.args, "featureId")
        ? feature(verb("Read the plan of", "Reading the plan of"))
        : words(verb("Read the plan", "Reading the plan"), "", false);
    case "dismiss_work_item":
      return text(verb("Cleared the feature's flag", "Clearing the feature's flag"), "reason");
    case "canvas_create":
      return text(verb("Created canvas", "Creating canvas"), "title");
    case "canvas_publish":
      return words(verb("Published canvas", "Publishing canvas"), canvasTitleOf(row) ?? "", false);
    case "canvas_read":
      return words(verb("Read canvas", "Reading canvas"), resultString(row, "title") ?? canvas() ?? "", false);
    case "canvas_update":
      return words(verb("Updated canvas", "Updating canvas"), stringArg(call.args, "title") ?? canvas() ?? "", false);
    case "canvas_outline":
      return words(verb("Outlined canvas", "Outlining canvas"), canvas() ?? "", false);
    case "canvas_remove_section":
      return words(verb("Removed a section of canvas", "Removing a section of canvas"), canvas() ?? "", false);
    case "feature_message_send":
      return feature(verb("Messaged", "Messaging"));
    case "read_feature_thread":
      return feature(verb("Read the thread of", "Reading the thread of"));
    case "get_feature_status":
      return feature(verb("Checked", "Checking"));
    case "archive_feature":
      return feature(verb("Archived", "Archiving"));
    case "restore_feature":
      return feature(verb("Restored", "Restoring"));
    case "create_feature":
      return text(verb("Created feature", "Creating feature"), "name");
    case "list_features":
      return words(verb("Listed features", "Listing features"), "", false);
    case "create_project":
      return text(verb("Created project", "Creating project"), "name");
    case "list_projects":
      return words(verb("Listed projects", "Listing projects"), "", false);
    case "archive_project":
      return words(verb("Archived a project", "Archiving a project"), "", false);
    case "schedule_wake": {
      // When it fires, as the server worked it out from `when` (which takes
      // durations and dates in many forms): the result's fireAt, read in the
      // viewer's time. Until then, no time is claimed.
      const fireAt = formatDateTime(resultString(row, "fireAt"));
      return fireAt
        ? words("Scheduled a wake for", fireAt, false)
        : words(verb("Scheduled a wake", "Scheduling a wake"), "", false);
    }
    case "cancel_alarm":
      // Cancelling one that already fired comes back ok, with its status.
      return resultString(row, "status") === "fired"
        ? words("Alarm had already fired", "", false)
        : words(verb("Cancelled an alarm", "Cancelling an alarm"), "", false);
    case "list_my_alarms":
      return words(verb("Listed alarms", "Listing alarms"), "", false);
    case "list_my_monitors":
      return words(verb("Listed monitors", "Listing monitors"), "", false);
    case "cancel_monitor":
      return words(verb("Cancelled a monitor", "Cancelling a monitor"), "", false);
    case "chat_history_search":
      return text(verb("Searched history for", "Searching history for"), "query");
    case "chat_history_read":
      return words(verb("Read history", "Reading history"), "", false);
    case "end_sweep":
      return text(verb("Ended the sweep", "Ending the sweep"), "reason");
    case "name_thread": {
      // Named, renamed when the thread moved on to another task, or kept:
      // the user's name stays, and a repeat changes nothing. Its result says
      // which (thread-tools.ts); an earlier version named a thread once.
      const said = row.result && !row.result.isError && typeof row.result.result === "string" ? row.result.result : "";
      const users = said.match(/^The user named this thread "(.*)"; it stays\.$/)?.[1];
      if (users !== undefined) return words("Kept your thread name", users, false);
      const kept = said.match(/^This thread is already named "(.*)"(?:; only the user renames it)?\.$/)?.[1];
      if (kept !== undefined) return words("Thread already named", kept, false);
      return /^Renamed this thread /.test(said)
        ? text(verb("Renamed the thread", "Renaming the thread"), "title")
        : text(verb("Named the thread", "Naming the thread"), "title");
    }
    // The global agent's own. A handoff that went through reads as its card;
    // these words are for one still under way, or refused.
    case "list_threads":
      return words(verb("Listed threads", "Listing threads"), "", false);
    case "read_thread":
      return words(verb("Read a thread", "Reading a thread"), "", false);
    case "waiting_on_you":
      return words(verb("Checked what waits on you", "Checking what waits on you"), "", false);
    // A question that went through is a line of its own in the conversation
    // (AskLine); these words are for one still on its way, or refused.
    case "ask_user":
      return text(verb("Asked you", "Asking you"), "question");
    // Which one, the question's own line says: it is marked withdrawn there
    // (and in the row that asked, that line stands for this call too).
    case "withdraw_question":
      return words(verb("Withdrew a question", "Withdrawing a question"), "", false);
    case "message_feature":
      return feature(verb("Messaged", "Messaging"));
    case "send_to_thread":
      return stringArg(call.args, "newThreadTitle")
        ? text(verb("Opened a thread", "Opening a thread"), "newThreadTitle")
        : words(verb("Sent to a thread", "Sending to a thread"), "", false);
    case "await_stop":
      return words(verb("Waiting for it to stop", "Arming a wait"), "", false);
    case "archive_thread":
      return words(verb("Archived a thread", "Archiving a thread"), "", false);
    default:
      return {
        lead: call.toolName,
        leadIsToolName: true,
        detail: summarizeArgs(call.args, canvasTitleOf(row)),
        detailIsCode: false
      };
  }
}

/** What an edit or a write changed in its file, in lines, as the server
 *  counted it over the whole file — an edit's own old and new text cannot
 *  say what it did to the lines around it. Null for any other call, for a
 *  call whose result does not say it succeeded on the very path it was
 *  asked for, and for one whose lines the server could not count. */
export function lineChanges(row: ToolRunRow): LineChanges | null {
  const value = row.result && !row.result.isError ? row.result.result : undefined;
  if (row.call.toolName === "edit") {
    const args = editArgs(row.call.args);
    const result = editResult(value);
    return args && result?.path === args.path ? result.changes : null;
  }
  if (row.call.toolName === "write") return writeOutcome(row)?.changes ?? null;
  return null;
}

/** A write's result, when it names the very path the write was asked for. */
function writeOutcome(row: ToolRunRow) {
  const args = writeArgs(row.call.args);
  const outcome = row.result && !row.result.isError ? writeResult(row.result.result) : null;
  return args && outcome?.path === args.path ? outcome : null;
}

function createdFile(row: ToolRunRow): boolean {
  return writeOutcome(row)?.created === true;
}

/** Counted phrases for a run of several calls: "ran 3 commands". */
const KINDS = new Map<string, (n: number) => string>([
  ["bash", (n) => `ran ${n} ${n === 1 ? "command" : "commands"}`],
  ["read", (n) => `read ${n} ${n === 1 ? "file" : "files"}`],
  ["edit", (n) => `edited ${n} ${n === 1 ? "file" : "files"}`],
  ["created", (n) => `created ${n} ${n === 1 ? "file" : "files"}`],
  ["send_keys", (n) => (n === 1 ? "sent keys once" : `sent keys ${n} times`)],
  ["read_pane", (n) => (n === 1 ? "read a pane" : `read panes ${n} times`)],
  // Times, not panes: a second watch of one pane updates it.
  ["watch_window", (n) => (n === 1 ? "watched a pane" : `watched panes ${n} times`)],
  ["monitor", (n) => (n === 1 ? "monitored a command" : `monitored commands ${n} times`)],
  // The worker updates its own plan; the manager reads any feature's.
  ["update_plan", (n) => (n === 1 ? "updated the plan" : `updated the plan ${n} times`)],
  ["read_plan", (n) => (n === 1 ? "read a plan" : `read plans ${n} times`)],
  ["web_search", (n) => (n === 1 ? "searched the web once" : `searched the web ${n} times`)],
  ["web_fetch", (n) => `fetched ${n} ${n === 1 ? "page" : "pages"}`]
]);
// Maps, not object literals: the model names the tool, and a name such as
// `constructor` must not find something on Object.prototype.
const KIND_OF = new Map([
  ["bash", "bash"], ["read", "read"], ["edit", "edit"], ["write", "edit"], ["send_keys", "send_keys"],
  ["read_pane", "read_pane"], ["update_plan", "update_plan"], ["read_plan", "read_plan"],
  ["web_search", "web_search"], ["web_fetch", "web_fetch"]
]);
/** What a call counts as in a run's tally: a pane monitor as the watch it
 *  replaced, a command monitor as a monitored command. */
function countedKind(row: ToolRunRow): string {
  if (row.call.toolName === "monitor") return objectArg(row.call.args, "command") ? "monitor" : "watch_window";
  return KIND_OF.get(row.call.toolName) ?? "other";
}
const usedTools = (n: number) => `used ${n} ${n === 1 ? "tool" : "tools"}`;

/** The calls that do a run's work, in the order its tally names them: what it
 *  changed first. Reading panes, the plan, watches and the rest are how the
 *  work gets done: counted, not named, so the line has room for what changed. */
const WORK = ["created", "edit", "bash", "send_keys", "read", "web_search", "web_fetch"];

/** What a finished run of several calls did, as its line says it. */
export interface RunTally {
  /** One per kind of work, the first capitalised: "Edited 2 files", "ran 3
   *  commands". A run that did no work names every kind it called instead,
   *  in the order each first appeared: it is short, and all there is. */
  clauses: string[];
  /** Calls no clause names: the line then says how many calls there were. */
  unnamed: number;
}

function tallyOf(rows: ToolRunRow[]): RunTally {
  const counts = new Map<string, number>();
  for (const row of rows) {
    // A write that made its file is said so; any other, an edit of it.
    const kind = createdFile(row) ? "created" : countedKind(row);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const work = WORK.filter((kind) => counts.has(kind));
  const said = work.length > 0 ? work.map((kind) => [kind, counts.get(kind)!] as const) : [...counts];
  const clauses = said.map(([kind, n], index) => {
    const clause = (KINDS.get(kind) ?? usedTools)(n);
    return index === 0 ? clause.charAt(0).toUpperCase() + clause.slice(1) : clause;
  });
  return { clauses, unnamed: rows.length - said.reduce((sum, [, n]) => sum + n, 0) };
}

export interface RunSummary {
  /** A single call, or the step a run under way is on: that call's words.
   *  Exactly one of this and `tally` is set. */
  phrase: CallPhrase | null;
  /** A finished run of several calls. */
  tally: RunTally | null;
  count: number;
  failed: number;
  running: boolean;
  /** The lines its calls changed, summed over those that say (lineChanges);
   *  null when none does. */
  lines: LineChanges | null;
}

export function describeRun(rows: ToolRunRow[], names?: CallNames): RunSummary {
  const failed = rows.filter((row) => rowStatus(row) === "error").length;
  const active = rows.find((row) => rowStatus(row) === "running");
  // A run in progress reads as the step it is on; a finished one as a tally.
  const one = rows.length === 1 || active ? active ?? rows[0]! : null;
  const phrase = one ? describeCall(one, names) : null;
  const tally = one ? null : tallyOf(rows);
  const counted = rows.map(lineChanges).filter((changes): changes is LineChanges => changes !== null);
  const lines = counted.length === 0
    ? null
    : counted.reduce((sum, changes) => ({ added: sum.added + changes.added, removed: sum.removed + changes.removed }));
  return { phrase, tally, count: rows.length, failed, running: Boolean(active), lines };
}

/** Below this, a duration is noise: it is dominated by the gap between when
 *  the step finished and when its result row was written, and most calls
 *  land in the same displayed second as the message above them anyway. */
const SLOW_TOOL_DURATION_MS = 1000;

/** How long a call took, or null whenever that cannot be known for certain.
 *
 *  There is no per-tool start on the wire — a tool message's `createdAt` is
 *  when it FINISHED. `startedAt` is derived by the caller from the preceding
 *  completed event, and every way that derivation can be wrong ends in null
 *  rather than a plausible-looking number: still running, never came back, an
 *  unparseable timestamp on either side, or an end before the start (the
 *  order walked was not the order things ran). Guessing was the bug this
 *  replaced — a second tool that really took 450ms read 7.8s because it was
 *  measured from the assistant message instead of from the tool before it. */
export function rowElapsedMs(row: ToolRunRow): number | null {
  if (row.isRunning || !row.startedAt || !row.result?.createdAt) return null;
  const ms = new Date(row.result.createdAt).getTime() - new Date(row.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** The duration worth printing: known, and slow enough to matter. */
export function slowDuration(ms: number | null): { ms: number; label: string } | null {
  if (ms === null || ms < SLOW_TOOL_DURATION_MS) return null;
  return { ms, label: formatDuration(ms) };
}

function recordArg(args: unknown, key: string): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  return (args as Record<string, unknown>)[key];
}

/** An argument that is itself an object (a monitor's `pane` or `command`), else null. */
function objectArg(args: unknown, key: string): Record<string, unknown> | null {
  const value = recordArg(args, key);
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function recordHas(args: unknown, key: string): boolean {
  return Boolean(args) && typeof args === "object" && !Array.isArray(args) && key in (args as object);
}

/** An id argument exactly as sent, blank or not a string being none. */
function exactArg(args: unknown, key: string): string | null {
  const value = recordArg(args, key);
  return typeof value === "string" && value !== "" ? value : null;
}

function stringArg(args: unknown, key: string): string | null {
  const value = recordArg(args, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Where tool-output-spool.ts saves an output: `…/tool-output/<thread>/<id>.txt`,
 *  joined with the server's separator (`\` on Windows). For a read whose
 *  source is not in this transcript — another thread's output, or a path
 *  the agent mistyped. */
function isSavedOutputPath(path: unknown): boolean {
  return typeof path === "string" && /[\\/]tool-output[\\/][^\\/]+[\\/][^\\/]+\.txt$/.test(path);
}

function fileName(args: unknown): string {
  const path = stringArg(args, "path") ?? stringArg(args, "file_path") ?? stringArg(args, "filePath") ?? "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}
