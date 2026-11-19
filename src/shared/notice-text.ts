import { markdownToText } from "./markdown-text.js";
import { AGENT_QUESTION_MATTER, TASK_REVIEW_LEAD } from "./api/notifications.js";

/** Marks that end a sentence wherever they stand. */
const FULL_STOPS = new Set(["。", "！", "？"]);
/** Marks that end one only before a space or the end: not inside an address or a name like !34. */
const HALF_STOPS = new Set([".", "!", "?"]);
/** Words a period follows without ending the sentence. */
const ABBREVIATIONS = new Set(["etc", "vs", "approx", "cf", "mr", "mrs", "ms", "dr", "no", "fig", "inc", "ltd", "jr", "sr", "st"]);

/** A period ends a sentence before a capital, a digit or CJK text, unless it
 *  closes an abbreviation (e.g., U.S., etc.). When unsure it does not: the
 *  line then keeps more, never less. */
function periodEnds(text: string, at: number, end: number): boolean {
  const next = /^\s+(\S)/.exec(text.slice(end))?.[1];
  if (next === undefined) return end >= text.length;
  if (!/[A-Z0-9\u3400-\u9fff]/.test(next)) return false;
  const word = /(\S+)$/.exec(text.slice(0, at))?.[1] ?? "";
  return word.length > 1 && !word.includes(".") && !ABBREVIATIONS.has(word.toLowerCase());
}
/** What may follow a sentence's mark and still belong to it. */
const CLOSERS = new Set(["）", ")", "」", "』", "\"", "'", "”", "’"]);

function sentencesOf(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const mark = text[i]!;
    if (!FULL_STOPS.has(mark) && !HALF_STOPS.has(mark)) continue;
    let end = i + 1;
    while (end < text.length && CLOSERS.has(text[end]!)) end++;
    if (HALF_STOPS.has(mark) && end < text.length && !/\s/.test(text[end]!)) continue;
    if (mark === "." && !periodEnds(text, i, end)) continue;
    out.push(text.slice(start, end));
    start = end;
    i = end - 1;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** A command in backticks belongs to its sentence: its marks are held out of
 *  the split (as private-use stand-ins) and given back after. */
const HELD: Record<string, string> = { ".": "\uE000", "!": "\uE001", "?": "\uE002", "。": "\uE003", "！": "\uE004", "？": "\uE005" };
const GIVEN_BACK: Record<string, string> = Object.fromEntries(Object.entries(HELD).map(([mark, held]) => [held, mark]));
const holdCodeMarks = (markdown: string) =>
  markdown.replace(/(`+)([^`]+?)\1/g, (_all, ticks: string, code: string) => ticks + code.replace(/[.!?。！？]/g, (mark) => HELD[mark]!) + ticks);
const giveBack = (text: string) => text.replace(/[\uE000-\uE005]/g, (held) => GIVEN_BACK[held]!);

/** The last sentence that asks; the whole text when none does. */
function askingSentence(text: string): string {
  const asks = sentencesOf(oneLine(text)).filter((s) => /[？?][）)」』"'”’]*$/.test(s));
  return asks.at(-1) ?? oneLine(text);
}

/** A question's sentence that asks, and its whole message on one line;
 *  both without markdown. */
function questionParts(body: string): { ask: string; whole: string } {
  const text = markdownToText(holdCodeMarks(body));
  return { ask: giveBack(askingSentence(text)), whole: giveBack(oneLine(text)) };
}

/** What an in-app notice shows: a short lead, and one line under it. A
 *  question shows the sentence that asks, not the message it came in; a task
 *  ready for review, the task's title. */
export function noticeLines(event: { key: string; title: string; body: string }): { lead: string; line: string } {
  if (event.key === AGENT_QUESTION_MATTER) return { lead: event.title, line: questionParts(event.body).ask };
  const text = markdownToText(holdCodeMarks(event.body));
  const reviewPrefix = `${TASK_REVIEW_LEAD}: `;
  if (event.key.startsWith("task:") && event.title.startsWith(reviewPrefix)) {
    return { lead: TASK_REVIEW_LEAD, line: event.title.slice(reviewPrefix.length).trim() };
  }
  return { lead: event.title, line: giveBack(oneLine(text)) };
}

/** A system notification's text under its title, of which the system shows
 *  two or three lines: a question's sentence that asks comes first, then its
 *  whole message on one line for what it is about (the system cuts what it
 *  cannot show). Other notices as they came. */
export function systemNoticeText(event: { key: string; body: string }): string {
  if (event.key !== AGENT_QUESTION_MATTER) return event.body;
  const { ask, whole } = questionParts(event.body);
  return whole === ask ? ask : `${ask} ${whole}`;
}

/** What a channel such as Telegram carries under the title: a question's
 *  sentence that asks comes first, so a preview shows it, then the message as
 *  written. Other notices as they came. */
export function channelNoticeText(event: { key: string; body: string }): string {
  if (event.key !== AGENT_QUESTION_MATTER) return event.body;
  const { ask, whole } = questionParts(event.body);
  return whole === ask ? event.body : `${ask}\n\n${event.body}`;
}
