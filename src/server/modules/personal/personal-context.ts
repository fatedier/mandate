import * as fs from "node:fs";
import * as path from "node:path";
import { renderPromptFile } from "../../platform/prompts/prompt-template.js";
import runtimeContextTemplatePath from "./prompts/personal-runtime-context.md" with { type: "file" };
import { formatAgentTime } from "../../platform/time/agent-time.js";

export interface PersonalContextInput {
  name: string;
  /** `state`: its word (threadContextWord); `stopReason`: why it stopped, for a stop. */
  threads: Array<{ title: string; lastActivityAt: string; state: string; stopReason: string | null; workerCount: number }>;
  workers: Array<{ name: string; projectName: string; ownerThreadTitle: string | null; waiting: string | null; currentStep: string | null }>;
  /** What waits on the user; `question`: the words of one put to them. */
  waiting: Array<{ label: string; workerName: string; threadTitle: string | null; question?: string }>;
  /** What the agent waits to hear from: one line per open wait. */
  waits: Array<{ target: string; since: string; sent: string | null }>;
  /** What the agent asked the user and has no answer to. */
  questions: Array<{ id: string; question: string }>;
  /** The agent's working directory, and `notes/index.md` as it is on disk (null: no such file). */
  workDir: string;
  notesIndex: string | null;
  /** The zone its times are written in, as the messages' are. */
  timeZone: string;
  /** The open tasks, one per line (renderTasksSection); absent: "No open tasks." */
  tasksSection?: string;
  /** The open sticky notes and those the user finished lately (renderStickyNotesSection); absent: "None open." */
  stickyNotesSection?: string;
  /** Its calendar's entries and the user's changes lately (renderCalendarSection); absent: "None." */
  calendarSection?: string;
  /** The notification channels it can name; none (or absent): no section. */
  channels?: Array<{ name: string; about: string; on: boolean }>;
}

const lines = (rows: string[]) => (rows.length > 0 ? rows.join("\n") : "None.");
const oneLine = (text: string, max = 120) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

export const NOTES_INDEX_MAX_CHARS = 8000;

/** A notes folder's `index.md` as it is on disk; null when there is none. */
export function readNotesIndex(notesDir: string): string | null {
  try {
    return fs.readFileSync(path.join(notesDir, "index.md"), "utf8");
  } catch {
    return null;
  }
}

/** The notes index for the context: the agent's own text, never parsed. */
export function renderNotesIndex(text: string | null): string {
  const body = (text ?? "").trim();
  if (!body) return "(empty)";
  if (body.length <= NOTES_INDEX_MAX_CHARS) return body;
  return `${body.slice(0, NOTES_INDEX_MAX_CHARS)}\n[Cut at ${NOTES_INDEX_MAX_CHARS} characters: shorten notes/index.md.]`;
}

/** The personal agent's runtime context: appended only when it changes, as
 *  every scope's is (wake-runtime-context). */
export function renderPersonalRuntimeContext(input: PersonalContextInput): string {
  const time = (at: string) => formatAgentTime(at, input.timeZone) ?? at;
  return renderPromptFile(runtimeContextTemplatePath, {
    name: input.name,
    threadsSection: lines(input.threads.map((t) => {
      const state = t.stopReason ? `${t.state}: ${oneLine(t.stopReason, 80)}` : t.state;
      return `- ${t.title} · ${state} · ${t.workerCount} worker${t.workerCount === 1 ? "" : "s"} · last activity ${time(t.lastActivityAt)}`;
    })),
    workersSection: lines(input.workers.map((w) => {
      const parts = [`- ${w.name} (${w.projectName})`, `thread: ${w.ownerThreadTitle ?? "none"}`];
      if (w.waiting) parts.push(w.waiting);
      if (w.currentStep) parts.push(`step: ${oneLine(w.currentStep, 80)}`);
      return parts.join(" · ");
    })),
    waitingSection: lines(input.waiting.map((w) =>
      `- ${w.workerName}: ${w.label} · thread: ${w.threadTitle ?? "none"}${w.question ? ` · asks: ${oneLine(w.question, 200)}` : ""}`)),
    waitsSection: lines(input.waits.map((w) => `- ${w.target} · since ${time(w.since)} · ${w.sent ? `"${oneLine(w.sent, 80)}"` : "nothing sent"}`)),
    // With the id that takes each back: a compaction can take the asking out
    // of the conversation the agent sees.
    questionsSection: lines(input.questions.map((q) => `- ${q.id} · ${oneLine(q.question, 200)}`)),
    tasksSection: input.tasksSection ?? "No open tasks.",
    stickyNotesSection: input.stickyNotesSection ?? "None open.",
    calendarSection: input.calendarSection ?? "None.",
    workDir: input.workDir,
    notesIndex: renderNotesIndex(input.notesIndex),
    // A section only once the user has set a channel up: before that the
    // context reads as it did without notifications.
    notificationChannels: input.channels && input.channels.length > 0
      ? `\n## Notification channels\n\n${input.channels.map((c) => `- ${c.name} · ${c.about}${c.on ? "" : " · off"}`).join("\n")}\n`
      : ""
  });
}
