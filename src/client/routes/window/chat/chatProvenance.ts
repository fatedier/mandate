import { Activity, AlarmClock, CheckCircle, CircleAlert, CircleQuestionMark, Eye, MessageSquare, Radar } from "lucide-react";
import { parseDurationMs } from "@shared/duration-short";
import type { AgentMessage } from "@/store/agent-chat";
import type { AgentWakeMetadata, AgentWakeReason } from "@shared/api-contracts";
import { threadHref } from "@/lib/feature-href";
import { formatCalendarDate, formatClockMinutes } from "@/lib/format";
import { QUIET_NOTICE_LABEL, THREAD_NOTICE_LABEL, threadNoticeOf, type ThreadNotice, type ThreadNoticeStop } from "@shared/thread-notice";

type ProvenanceIcon = typeof Activity;

/** The reply a notice brought: the handoffs it ended (their records hold
 *  what was said), what stopped, and how. */
export interface NoticeReplyRef { handoffIds: string[]; kind: ThreadNotice["kind"]; stop: ThreadNoticeStop }

/** Why the agent spoke: one line, above the reply the wake produced — what
 *  happened, in words ("Codex review went quiet for 30s", "Alarm"), and a
 *  detail on the same line (the watch's note, the alarm's, a task). */
export interface ChatProvenance {
  icon: ProvenanceIcon;
  /** What the label is about, ahead of it ("CI checks on PR 123 · succeeded"):
   *  a command shown as code when it has no description; a thread or worker
   *  that can be opened carries where, and with it whose reply the notice
   *  brought, which its name then opens in place. */
  subject?: { text: string; code: boolean; href?: string; reply?: NoticeReplyRef };
  label: string;
  /** May be empty. */
  detail: string;
  /** What a person may want past the line, which opens it: when and how it
   *  fired, the agent's note whole, the pane's last lines or the command's
   *  output. Not the message the model read: no ids, no words for the model. */
  facts?: CauseFacts;
  createdAt?: string;
}

export interface CauseFacts {
  /** How it fired, short: "Unchanged for 30s", "Every 2m", "Rang 15:04". */
  meta: string[];
  /** The agent's note, whole; may be empty. */
  note: string;
  /** A command monitor's recent runs, newest first, and how many came
   *  before them: its waiting line's card. */
  runs?: { rows: CauseRun[]; earlier: number };
  /** Text shown as it came: the pane's last lines, a command and its output. */
  blocks: Array<{ label: string; text: string }>;
}

/** One run as the card lists it: when, how it ended, its output's last line. */
export interface CauseRun {
  at: string;
  outcome: string;
  /** How it reads: what it waited for (ok), nothing new (same), or not yet / broken (fail). */
  tone: "ok" | "same" | "fail";
  line: string;
}

/** The wake reason a message in the transcript starts: a watch that fired, an
 *  alarm, a notice to the global agent. Such a message is its wake's cause line (see
 *  causeForTriggerMessage); null for any other message. */
export function triggerReason(message: AgentMessage): AgentWakeReason | null {
  if (message.role !== "user") return null;
  if (message.source === "watch") return "watch";
  if (message.source === "monitor") return "monitor";
  if (message.source === "alarm") return "alarm";
  if (message.source === "thread-notice") return "thread-notice";
  return null;
}

/** Why a wake happened when no message in the transcript says so: a worker
 *  check. Null for a wake whose trigger message is the cause line (watch,
 *  alarm, analyzer), for one the user started, and for one there is nothing
 *  to say about. */
export function provenanceForWake(
  reason: AgentWakeReason | null | undefined,
  opts: { wakeId?: string | null; createdAt?: string; metadata?: AgentWakeMetadata | null } = {}
): ChatProvenance | null {
  if (!reason) return null;
  const base = { createdAt: opts.createdAt };
  switch (reason) {
    case "work-item-heartbeat":
      return { ...base, icon: Activity, label: "Worker check", detail: "" };
    // The report card right above the reply is its cause, as a subagent's
    // result card is.
    case "worker-report":
    case "subagent-result":
    case "command-result":
      return null;
    default:
      return null;
  }
}

/** A trigger message (see triggerReason) as its wake's cause line. A pane
 *  monitor's event names its pane as the thread named it (`watchPane`, from
 *  the monitor call that registered it), else by id. */
export function causeForTriggerMessage(
  message: AgentMessage,
  watchPane: (monitorId: string) => string | null,
  workerHref?: (featureId: string) => string | null
): ChatProvenance | null {
  const text = message.content.type === "text" ? message.content.text : "";
  const base = { createdAt: message.createdAt };
  switch (triggerReason(message)) {
    case "watch": {
      // A pane monitor's event.
      const { fields, note, sections } = eventParts(text);
      const monitorId = fields.get("monitorId");
      // The name the pane had when the monitor was registered, which the
      // event carries; then the transcript's, which knows it
      // only when the call that named the pane is loaded; then the id.
      const pane = fields.get("paneName") || ((monitorId ? watchPane(monitorId) : null) ?? fields.get("paneId") ?? "A pane");
      const result = fields.get("result");
      // How long the screen stayed unchanged.
      const unchangedFor = fields.get("unchangedFor");
      const stableMs = unchangedFor ? parseDurationMs(unchangedFor) ?? NaN : NaN;
      const quiet = Number.isFinite(stableMs) && stableMs > 0 ? ` for ${formatStableWindow(stableMs)}` : "";
      const label = result === "timeout"
        ? `Monitor on ${pane} timed out`
        : result === "target_missing"
          ? `${pane} is gone`
          : `${pane} went quiet${quiet}`;
      const facts: CauseFacts = {
        meta: [result === "timeout" ? "Timed out" : result === "target_missing" ? "The pane closed" : quiet ? `Unchanged${quiet}` : ""].filter(Boolean),
        note,
        blocks: shownBlocks([["Last lines of the pane", sections.get("paneTail")]])
      };
      return { ...base, icon: Eye, label, detail: inlineDetail(note), facts };
    }
    case "monitor": {
      // What it watched — its description, else its command — then what happened.
      const { fields, note, sections } = eventParts(text);
      const description = fields.get("description");
      const result = fields.get("result");
      const label = result === "succeeded" ? "succeeded"
        : result === "changed" ? "changed"
          : result === "timeout" ? "timed out"
            // After COMMAND_MONITOR_LIMITS.failuresToFire failed runs.
            : result === "failing" ? "failed 5 runs in a row"
              : result ?? "fired";
      const command = fields.get("command");
      const subject = description ? { text: description, code: false } : { text: command ?? "A command", code: true };
      const every = fields.get("every");
      const when = fields.get("wakeWhen");
      // Only a timeout's event says how its last run exited.
      const exit = sections.get("exit code");
      const facts: CauseFacts = {
        meta: [
          every ? `Every ${every}` : "",
          when === "succeeds" ? "Wakes when it succeeds" : when === "changed" ? "Wakes when it changes" : "",
          exit ? `Exit code ${exit}` : ""
        ].filter(Boolean),
        note,
        // Whole, even when it is the title too: the title is cut to one line.
        blocks: shownBlocks([
          ["Command", command],
          ["Changes", sections.get("changes")],
          ["Output", sections.get("output")],
          ["Last error", sections.get("last error")],
          ["Error output", sections.get("stderr")]
        ])
      };
      return { ...base, icon: Radar, subject, label, detail: inlineDetail(note), facts };
    }
    case "alarm": {
      // An alarm's note is its last part: read to the end, whatever its lines say.
      const parts = eventParts(text, { noteToEnd: true });
      return { ...base, icon: AlarmClock, label: "Alarm", detail: inlineDetail(parts.note), facts: alarmFacts(parts, message.createdAt) };
    }
    // What the global agent waits on has stopped, or asked the user a
    // question while it works on, or that question was settled there: who, a
    // way there while there is one, and what happened.
    case "thread-notice": {
      const notice = threadNoticeOf(message.content);
      if (!notice) return null;
      const stop = notice.stop;
      const href = stop === "archived"
        ? null
        : notice.kind === "feature"
          ? (notice.featureId ? workerHref?.(notice.featureId) ?? null : null)
          : (notice.targetThreadId ? threadHref(notice.targetThreadId) : null);
      // A question, asked or settled: the name leads to the thread. No wait
      // ended, so there is no reply to open.
      if (stop === "asked" || stop === "settled") {
        return {
          ...base,
          icon: stop === "asked" ? CircleQuestionMark : CheckCircle,
          subject: { text: notice.title, code: false, ...(href ? { href } : {}) },
          label: THREAD_NOTICE_LABEL[stop],
          detail: inlineDetail(notice.question?.text ?? "")
        };
      }
      return {
        ...base,
        icon: stop === "failed" ? CircleAlert : MessageSquare,
        subject: {
          text: notice.title,
          code: false,
          ...(href ? { href } : {}),
          ...(href && notice.handoffIds.length > 0 ? { reply: { handoffIds: notice.handoffIds, kind: notice.kind, stop } } : {})
        },
        // A quiet notice says what the thread left for the user.
        label: (notice.direct || notice.after) && notice.verdict && notice.verdict !== "nothing" ? QUIET_NOTICE_LABEL[notice.verdict] : THREAD_NOTICE_LABEL[stop],
        detail: notice.reason ?? ""
      };
    }
    default:
      return null;
  }
}

/** When an alarm was set for (its event's `fired at`, the time it was due:
 *  `scheduled at` is when it was set) and when it rang (its message's own
 *  time), in the reader's clock, with the days when they differ; its note. */
function alarmFacts(parts: EventParts, rangAt: string): CauseFacts {
  const due = agentTime(parts.fields.get("fired at"));
  const rang = Date.parse(rangAt);
  const day = (ms: number) => new Date(ms).toDateString();
  const sameDay = due === null || typeof due === "string" || !Number.isFinite(rang) || day(due) === day(rang);
  const shown = (ms: number) => (sameDay ? formatClockMinutes(ms) : `${formatCalendarDate(ms)} ${formatClockMinutes(ms)}`);
  return {
    meta: [
      due === null ? "" : `Set for ${typeof due === "string" ? due : shown(due)}`,
      Number.isFinite(rang) ? `Rang ${shown(rang)}` : ""
    ].filter(Boolean),
    note: parts.note,
    blocks: []
  };
}

/** A time as the server writes it to an agent ("Tue 2026-10-27 15:00
 *  +08:00", or in an older event the ISO instant): the instant, else the
 *  text as it is; null when absent. */
function agentTime(value: string | undefined): number | string | null {
  if (!value) return null;
  // An older event wrote the instant itself.
  if (/^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))) return Date.parse(value);
  const m = value.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})\s*([+-]\d{2}:\d{2})?/);
  const ms = m ? Date.parse(`${m[1]}T${m[2]!.padStart(2, "0")}:${m[3]}:00${m[4] ?? "Z"}`) : NaN;
  return Number.isFinite(ms) ? ms : value;
}

/** The blocks with something in them: a section that is empty or says
 *  "(empty)" (the server's word for no output) shows nothing. */
function shownBlocks(candidates: Array<[string, string | undefined]>): CauseFacts["blocks"] {
  return candidates.flatMap(([label, text]) =>
    text !== undefined && !["", "(empty)"].includes(text.trim()) ? [{ label, text }] : []);
}

/** An event as the server writes it (window-watch-manager,
 *  command-monitor-manager, agent-alarm-manager): a header line; its fields,
 *  `key: value` a line; the agent's note; the line telling the model what to
 *  do; then its sections — a pane's tail, a command's changes, output, last
 *  error and stderr (`| `-quoted where they are output), and how a timed-out
 *  run exited. The note is read whole, an older one spanning lines, up to
 *  that line (an alarm's note is its last); nothing in it is read as a field
 *  or a section. */
interface EventParts {
  fields: Map<string, string>;
  note: string;
  /** By name: "paneTail", "changes", "output", "last error", "stderr", and
   *  "exit code"; the text as it came, unquoted. */
  sections: Map<string, string>;
}

const SECTION_HEADER = /^(paneTail|changes|output|last error|stderr)\b[^:]*:\s*(.*)$/;
const LAST_RUN = /^last run: exit code (\S+)$/;

function eventParts(text: string, { noteToEnd = false }: { noteToEnd?: boolean } = {}): EventParts {
  const lines = text.split("\n").slice(1);
  const fields = new Map<string, string>();
  let at = 0;
  for (; at < lines.length; at += 1) {
    const line = lines[at]!;
    if (line.startsWith("note:") || line.startsWith("action:")) break;
    const match = line.match(/^(\w[\w ]*?):\s*(.*)$/);
    if (match && !fields.has(match[1]!)) fields.set(match[1]!, match[2]!.trim());
  }
  const noteLines: string[] = [];
  if (lines[at]?.startsWith("note:")) {
    noteLines.push(lines[at]!.replace(/^note:\s*/, ""));
    // To the line for the model: the last that starts "action:", since only
    // section headers and marked lines follow it (an older note could hold
    // such a line of its own); an older event without one, to its first section.
    const action = noteToEnd ? -1 : lines.findLastIndex((line, k) => k > at && line.startsWith("action:"));
    const end = noteToEnd ? -1 : action >= 0 ? action : lines.findIndex((line, k) => k > at && (SECTION_HEADER.test(line) || LAST_RUN.test(line)));
    const stop = end >= 0 ? end : lines.length;
    noteLines.push(...lines.slice(at + 1, stop));
    at = stop;
  }
  if (lines[at]?.startsWith("action:")) at += 1;
  const sections = new Map<string, string>();
  let current: { name: string; quoted: boolean; lines: string[] } | null = null;
  const close = () => {
    if (current && !sections.has(current.name)) sections.set(current.name, current.lines.join("\n"));
    current = null;
  };
  for (const line of lines.slice(at)) {
    // The server's word that it could not read the pane: no tail at all.
    if (line === "paneTail: unavailable") {
      close();
      continue;
    }
    const lastRun = line.match(LAST_RUN);
    const header = lastRun ? null : line.match(SECTION_HEADER);
    if (lastRun) {
      close();
      if (!sections.has("exit code")) sections.set("exit code", lastRun[1]!);
    } else if (header) {
      close();
      current = { name: header[1]!, quoted: line.includes("(untrusted"), lines: header[2] ? [header[2]] : [] };
    } else if (current) {
      current.lines.push(current.quoted ? line.replace(/^\| ?/, "") : line);
    }
  }
  close();
  return { fields, note: noteLines.join("\n").trim(), sections };
}

/** The configured stability window a watch was waiting on — a setting, not a
 *  measurement, which is why whole minutes and whole seconds are the normal
 *  case and get rendered as such. */
function formatStableWindow(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function inlineDetail(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
