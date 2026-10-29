import { diffLines, type LineChanges, type LineDiff } from "@shared/line-diff";

export function formatPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ArgKind = "string" | "number" | "boolean" | "string[]";

function isKind(value: unknown, kind: ArgKind): boolean {
  if (kind === "string[]") return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
  return typeof value === kind;
}

/** A call's arguments when they are exactly what a view knows how to show —
 *  no key it does not know, each of its kind, the required ones present — or
 *  null. On null the call is shown by the generic view, argument by argument,
 *  so nothing the model sent (a malformed call included) is lost to a view
 *  that would not have drawn it. A null optional is taken as absent, as the
 *  generic view takes it. */
function argsOfShape(args: unknown, required: Record<string, ArgKind>, optional: Record<string, ArgKind>) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const record = args as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    const kind = required[key] ?? optional[key];
    if (!kind) return null;
    if ((value === null || value === undefined) && !(key in required)) continue;
    if (!isKind(value, kind)) return null;
  }
  for (const key of Object.keys(required)) if (!(key in record)) return null;
  return record;
}

/** bash's parameters (see tools/bash.ts). */
interface BashArgs {
  command: string;
  description?: string | null;
  cwd?: string | null;
  timeout?: number | null;
  /** Run in the background: the call returned its task at once. */
  run_in_background?: boolean | null;
}

export function bashArgs(args: unknown): BashArgs | null {
  return argsOfShape(args, { command: "string" }, { description: "string", cwd: "string", timeout: "number", run_in_background: "boolean" }) as BashArgs | null;
}

/** edit's parameters (see tools/edit-file.ts). */
interface EditArgs {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean | null;
}

export function editArgs(args: unknown): EditArgs | null {
  return argsOfShape(args, { path: "string", oldString: "string", newString: "string" }, { replaceAll: "boolean" }) as EditArgs | null;
}

/** send_keys's parameters (see panes/tools/send-keys.ts). */
interface SendKeysArgs {
  paneId: string;
  args: string[];
  description?: string | null;
}

export function sendKeysArgs(args: unknown): SendKeysArgs | null {
  return argsOfShape(args, { paneId: "string", args: "string[]" }, { description: "string" }) as SendKeysArgs | null;
}

/** read_pane's parameters (see panes/tools/read-pane.ts). */
interface ReadPaneArgs {
  paneId: string;
  lines?: number | null;
}

export function readPaneArgs(args: unknown): ReadPaneArgs | null {
  return argsOfShape(args, { paneId: "string" }, { lines: "number" }) as ReadPaneArgs | null;
}

/** monitor's parameters (see agent/tools/monitor.ts): exactly one of a pane
 *  (a worker's names no feature) or a command. */
interface PaneMonitorArgs {
  paneId: string;
  unchangedFor?: string | null;
  featureId?: string | null;
  projectSlug?: string | null;
  featureSlug?: string | null;
}
export interface CommandMonitorArgs {
  run: string;
  every: string;
  wakeWhen?: "changed" | "succeeds" | null;
  description?: string | null;
}
interface MonitorArgs {
  pane: PaneMonitorArgs | null;
  command: CommandMonitorArgs | null;
  timeout?: string | null;
  note?: string | null;
}

export function monitorArgs(args: unknown): MonitorArgs | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const { pane, command, ...rest } = args as Record<string, unknown>;
  const top = argsOfShape(rest, {}, { timeout: "string", note: "string" });
  const paneArgs = pane == null ? null : argsOfShape(pane, { paneId: "string" }, { unchangedFor: "string", featureId: "string", projectSlug: "string", featureSlug: "string" });
  const commandArgs = command == null ? null : argsOfShape(command, { run: "string", every: "string" }, { wakeWhen: "string", description: "string" });
  if (!top || (pane != null && !paneArgs) || (command != null && !commandArgs)) return null;
  if (Boolean(paneArgs) === Boolean(commandArgs)) return null;
  const wakeWhen = commandArgs?.wakeWhen;
  if (wakeWhen != null && wakeWhen !== "changed" && wakeWhen !== "succeeds") return null;
  return { ...top, pane: paneArgs as PaneMonitorArgs | null, command: commandArgs as CommandMonitorArgs | null };
}

/** A command monitor's result, in exactly one of the shapes the server
 *  returns (tools/monitor.ts): each key known and of its kind, each value one
 *  the server sends. Anything else is null, for the generic view to show. */
type CommandMonitorResult =
  | { kind: "registered"; output: string; exitCode: number | null; stderr: string | null }
  | { kind: "satisfied"; output: string; stderr: string | null }
  | { kind: "refused"; error: string; output: string | null };

export function commandMonitorResult(value: unknown): CommandMonitorResult | null {
  const refused = argsOfShape(value, { error: "string" }, { output: "string" });
  if (refused) return { kind: "refused", error: refused.error as string, output: (refused.output as string | undefined) ?? null };
  // What the first run wrote to stderr, and the server's warning about it,
  // come with the output when there is any.
  const satisfied = argsOfShape(value, { status: "string", kind: "string", exitCode: "number", output: "string" }, { note: "string", stderr: "string", warning: "string" });
  if (satisfied) {
    // A check that held: the command exited 0.
    return satisfied.status === "already_satisfied" && satisfied.kind === "command" && satisfied.exitCode === 0
      ? { kind: "satisfied", output: satisfied.output as string, stderr: (satisfied.stderr as string | undefined) ?? null }
      : null;
  }
  const registered = argsOfShape(
    value,
    { status: "string", monitorId: "string", kind: "string", every: "string", wakeWhen: "string", timeoutAt: "string", output: "string" },
    { nextRunAt: "string", exitCode: "number", stderr: "string", warning: "string" }
  );
  if (!registered) return null;
  if (registered.status !== "registered" && registered.status !== "updated" && registered.status !== "already_registered") return null;
  if (registered.kind !== "command" || (registered.wakeWhen !== "changed" && registered.wakeWhen !== "succeeds")) return null;
  return {
    kind: "registered",
    output: registered.output as string,
    exitCode: typeof registered.exitCode === "number" ? registered.exitCode : null,
    stderr: (registered.stderr as string | undefined) ?? null
  };
}

/** read's parameters (see agent/tools/read-file.ts). */
interface ReadArgs {
  path: string;
  offset?: number | null;
  limit?: number | null;
}

export function readArgs(args: unknown): ReadArgs | null {
  return argsOfShape(args, { path: "string" }, { offset: "number", limit: "number" }) as ReadArgs | null;
}

/** web_search's parameters (see web/web-search-tool.ts). */
export function webSearchArgs(args: unknown): { query: string } | null {
  return argsOfShape(args, { query: "string" }, {}) as { query: string } | null;
}

/** web_fetch's parameters (see web/web-fetch-tool.ts). */
export function webFetchArgs(args: unknown): { url: string; offset?: number | null } | null {
  return argsOfShape(args, { url: "string" }, { offset: "number" }) as { url: string; offset?: number | null } | null;
}

/** write's parameters (see agent/tools/write-file.ts). */
interface WriteArgs {
  path: string;
  content: string;
}

export function writeArgs(args: unknown): WriteArgs | null {
  return argsOfShape(args, { path: "string", content: "string" }, {}) as WriteArgs | null;
}

/** What a read_pane result holds: the screen, and the notes addressed to the
 *  agent around it (see panes/tools/read-pane.ts and pane-read-collapse.ts) —
 *  a watch it already holds, how much above is unchanged since its last read,
 *  a nudge after several reads with nothing new. The screen is null when
 *  nothing was new. */
interface PaneRead {
  before: string[];
  screen: string | null;
  after: string[];
}

const WATCH_NOTE = /^You already have a monitor on this pane \(.*\)\. It will wake you — re-reading does not make it fire sooner\.$/;
const NOTHING_NEW = /^no new output in \S+ since your last read \(\d+ lines? unchanged\)$/;
const UNCHANGED_ABOVE = /^… \d+ lines? unchanged since your last read of this pane$/;
const IDLE_NUDGE = /^This pane has not changed across your last \d+ reads\. monitor with a pane /;

export function parsePaneRead(text: string): PaneRead {
  const lines = text.split("\n");
  const before: string[] = [];
  if (lines.length > 0 && WATCH_NOTE.test(lines[0]!)) before.push(lines.shift()!);
  if (lines.length > 0 && NOTHING_NEW.test(lines[0]!)) {
    before.push(lines.shift()!);
    const after = lines.length > 0 && IDLE_NUDGE.test(lines[0]!) ? [lines.shift()!] : [];
    if (lines.length === 0) return { before, screen: null, after };
    return { before: [], screen: text, after: [] };
  }
  if (lines.length > 0 && UNCHANGED_ABOVE.test(lines[0]!)) before.push(lines.shift()!);
  return { before, screen: lines.join("\n"), after: [] };
}

/** A read result's lines with their numbers: `     1\tfirst line` (see
 *  read-file.ts formatReadLines) — numbers padded to six columns, one after
 *  another. Null when any line is not exactly that, so a result in another
 *  shape is shown whole rather than given a gutter it did not have. */
export interface NumberedLine {
  number: number;
  text: string;
}

export function parseNumberedLines(value: unknown): NumberedLine[] | null {
  if (typeof value !== "string") return null;
  const lines: NumberedLine[] = [];
  const rows = value.split("\n");
  // A whole-file read cut to its first page says so on its first line.
  if (/^\[PARTIAL view: [^\n]*\]$/.test(rows[0] ?? "")) rows.shift();
  for (const line of rows) {
    const match = /^ *(\d+)\t/.exec(line);
    if (!match) return null;
    const number = Number(match[1]);
    // Exactly as formatReadLines writes it, and one after the line before.
    if (match[0] !== `${String(number).padStart(6, " ")}\t`) return null;
    if (lines.length > 0 && number !== lines[lines.length - 1]!.number + 1) return null;
    lines.push({ number, text: line.slice(match[0].length) });
  }
  return lines;
}

/** What a bash call's transcript holds, taken apart. The server writes
 *  `stdout:\n…`, then `stderr:\n…`, each only when there was some, and always
 *  ends on `exitCode: N` (see formatBashResult in tools/bash.ts). */
interface BashTranscript {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const STDOUT = "stdout:\n";
/** A bash transcript's last line, `exitCode: N`. -1 is not one cause: the
 *  shell could not start, or the command was killed (a timeout, a signal) and
 *  left no code of its own; stderr says which. */
export const BASH_EXIT_LINE = /(?:^|\n)exitCode: (-?\d+)\s*$/;

const STDERR = "stderr:\n";

/** Null for anything not in that shape — a result spooled to a file and cut to
 *  a preview, say — which then shows as plain output. */
export function parseBashResult(value: unknown): BashTranscript | null {
  if (typeof value !== "string") return null;
  const tail = BASH_EXIT_LINE.exec(value);
  if (!tail) return null;
  const head = value.slice(0, tail.index);
  const exitCode = Number(tail[1]);
  if (head === "") return { stdout: "", stderr: "", exitCode };
  if (head.startsWith(STDERR)) return { stdout: "", stderr: head.slice(STDERR.length), exitCode };
  if (!head.startsWith(STDOUT)) return null;
  const body = head.slice(STDOUT.length);
  // The last marker: a command's stdout can print "stderr:" on a line of its
  // own; its stderr printing one after the real marker is far less likely.
  const cut = body.lastIndexOf(`\n${STDERR}`);
  return cut < 0
    ? { stdout: body, stderr: "", exitCode }
    : { stdout: body.slice(0, cut), stderr: body.slice(cut + 1 + STDERR.length), exitCode };
}

/** What an edit's success text says it did (edit-file.ts editSummary): the
 *  path it names, the places it replaced, and the lines it changed in the
 *  file — null in a result from before it said, or when too large to count.
 *  Null for any other text. */
interface EditResult {
  path: string;
  places: number;
  changes: LineChanges | null;
}

export function editResult(value: unknown): EditResult | null {
  if (typeof value !== "string") return null;
  // A path can hold any character but NUL, a newline included (`s`).
  const match = /^Updated (.+) \((\d+) replacements?(?:, \+(\d+) -(\d+) lines)?\)\.$/s.exec(value);
  if (!match) return null;
  const changes = match[3] === undefined ? null : { added: Number(match[3]), removed: Number(match[4]) };
  return { path: match[1]!, places: Number(match[2]), changes };
}

/** How many places an edit changed, from its result, naming the very path it
 *  was asked for. Null for any other text — the server's resolved path
 *  differing from the one asked for (a `..` in it) included, so that result
 *  is shown. */
export function editReplacements(value: unknown, path: string): number | null {
  const result = editResult(value);
  return result?.path === path ? result.places : null;
}

/** What a write's success text says it did (write-file.ts writeSummary):
 *  the path it names, whether it created the file, and the lines it changed,
 *  when it could count them. Null for any other text. */
interface WriteResult {
  path: string;
  created: boolean;
  changes: LineChanges | null;
}

export function writeResult(value: unknown): WriteResult | null {
  if (typeof value !== "string") return null;
  // A path can hold any character but NUL, a newline included (`s`).
  const created = /^Created (.+) \(\d+ bytes?, (\d+) lines?\)\.$/s.exec(value);
  if (created) return { path: created[1]!, created: true, changes: { added: Number(created[2]), removed: 0 } };
  const overwrote = /^Overwrote (.+) \(\d+ bytes?(?:, \+(\d+) -(\d+) lines)?\)\.$/s.exec(value);
  if (overwrote) {
    const changes = overwrote[2] === undefined ? null : { added: Number(overwrote[2]), removed: Number(overwrote[3]) };
    return { path: overwrote[1]!, created: false, changes };
  }
  return null;
}

/** A write's success text naming the very path it was asked for. */
export function isWriteSuccess(value: unknown, path: string): boolean {
  return writeResult(value)?.path === path;
}

/** Above this many line pairs an alignment costs too much to build on a
 *  render (see diffLines). */
const MAX_DIFF_CELLS = 250_000;

/** A line diff of an edit's old and new text, to draw (see diffLines). */
export function lineDiff(before: string, after: string): LineDiff {
  return diffLines(before.split("\n"), after.split("\n"), MAX_DIFF_CELLS);
}
