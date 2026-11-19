import { stripAnsi } from "../../platform/text/text.js";

/** Every limit a schedule's check and its handling keep to. */
export const SCHEDULE_LIMITS = {
  concurrent: 4,
  /** A due time this soon after the last run is skipped. */
  floorMs: 60_000,
  checkTimeoutDefaultMs: 60_000,
  checkTimeoutMaxMs: 600_000,
  /** How long run_now holds the personal agent's turn before its check goes on in the background. */
  foregroundMs: 30_000,
  scriptMaxBytes: 16_384,
  stateMaxBytes: 16_384,
  briefMaxChars: 4000,
  /** A wake's message and new items, past this, are cut where it is read:
   *  the whole is saved to a file the wake names (cutKeepingWhole). */
  wakeBodyMaxChars: 3000,
  contextTailChars: 4000,
  stderrTailChars: 1000,
  itemIdMaxChars: 200,
  /** A longer title is cut to this, with an ellipsis. */
  itemTitleMaxChars: 300,
  seenMax: 2000,
  captureMaxBytes: 262_144,
  failNotifyAt: 3,
  failPauseAt: 5
} as const;

export interface CheckRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface CheckItem {
  id: string;
  title: string | null;
  version: string | null;
}

export type CheckParse =
  /** `items` is null when the check gave none: then `wake` alone decides. */
  | { ok: true; wake: boolean; message: string | null; state: unknown | undefined; items: CheckItem[] | null; context: string }
  | { ok: false; error: string };

/** Item ids already delivered with their versions, the newest last. */
export type SeenItems = Array<[id: string, version: string | null]>;

/** What a check said, read from its last non-empty line of output. A
 *  timeout, a non-zero exit, or a last line that is not the agreed object is
 *  a failed run. What it reports is taken whatever its length (the wake fits
 *  it); what is kept for it or keys its items, the state and an item's id,
 *  over its limit is refused, never cut. */
export function parseCheckOutput(run: CheckRun): CheckParse {
  if (run.timedOut) return { ok: false, error: "the check timed out" };
  const lines = clean(run.stdout);
  if (run.exitCode !== 0) {
    const stderr = clean(run.stderr).join("\n").slice(-SCHEDULE_LIMITS.stderrTailChars);
    return { ok: false, error: `the check ended with exit ${run.exitCode}${stderr ? `: ${stderr}` : ""}` };
  }
  const last = lines.at(-1);
  if (last === undefined) return { ok: false, error: "the check printed nothing; its last line must be a JSON object" };
  let body: unknown;
  try {
    body = JSON.parse(last);
  } catch {
    return { ok: false, error: `the check's last line is not JSON: ${last.slice(0, 200)}` };
  }
  if (!isRecord(body)) return { ok: false, error: "the check's last line must be a JSON object" };
  if (typeof body.wake !== "boolean") return { ok: false, error: '"wake" must be true or false' };
  let message: string | null = null;
  if (body.message !== undefined && body.message !== null) {
    if (typeof body.message !== "string") return { ok: false, error: '"message" must be a string' };
    message = body.message;
  }
  if (body.state !== undefined) {
    if (!isRecord(body.state)) return { ok: false, error: '"state" must be a JSON object' };
    if (Buffer.byteLength(JSON.stringify(body.state)) > SCHEDULE_LIMITS.stateMaxBytes) {
      return { ok: false, error: `"state" is over ${SCHEDULE_LIMITS.stateMaxBytes} bytes` };
    }
  }
  let items: CheckItem[] | null = null;
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) return { ok: false, error: '"items" must be an array' };
    items = [];
    for (const raw of body.items) {
      const item = readItem(raw);
      if (typeof item === "string") return { ok: false, error: item };
      items.push(item);
    }
  }
  const context = lines.slice(0, -1).join("\n").slice(-SCHEDULE_LIMITS.contextTailChars);
  return { ok: true, wake: body.wake, message, state: body.state, items, context };
}

/** Whether a check that ran wakes its thread, and the items it delivers.
 *  Without items, `wake` decides; with items (an empty list included), only
 *  items not delivered before, or whose version changed, can wake. Items are
 *  marked delivered only by a wake. */
export function decideCheck(parse: Extract<CheckParse, { ok: true }>, seen: SeenItems): { kind: "quiet" | "wake"; newItems: CheckItem[]; seen: SeenItems } {
  if (!parse.wake) return { kind: "quiet", newItems: [], seen };
  if (parse.items === null) return { kind: "wake", newItems: [], seen };
  const known = new Map(seen);
  const listed = new Set<string>();
  const newItems = parse.items.filter((item) => {
    if (listed.has(item.id)) return false;
    listed.add(item.id);
    return !known.has(item.id) || known.get(item.id) !== item.version;
  });
  if (newItems.length === 0) return { kind: "quiet", newItems: [], seen };
  const fresh = new Set(newItems.map((item) => item.id));
  const next: SeenItems = [...seen.filter(([id]) => !fresh.has(id)), ...newItems.map((item): [string, string | null] => [item.id, item.version])];
  return { kind: "wake", newItems, seen: keepNewest(next, listed) };
}

/** The seen list cut to its limit, the oldest first, but never an item this
 *  run listed: forgotten while still listed, it would wake again next run. */
function keepNewest(seen: SeenItems, listed: ReadonlySet<string>): SeenItems {
  let over = seen.length - SCHEDULE_LIMITS.seenMax;
  if (over <= 0) return seen;
  const kept: SeenItems = [];
  for (const entry of seen) {
    if (over > 0 && !listed.has(entry[0])) {
      over -= 1;
      continue;
    }
    kept.push(entry);
  }
  return kept;
}

function readItem(raw: unknown): CheckItem | string {
  if (!isRecord(raw)) return "each item must be a JSON object";
  if (typeof raw.id !== "string" || raw.id.length === 0) return 'each item needs a non-empty string "id"';
  if (raw.id.length > SCHEDULE_LIMITS.itemIdMaxChars) return `an item id is over ${SCHEDULE_LIMITS.itemIdMaxChars} characters`;
  let title: string | null = null;
  if (raw.title !== undefined && raw.title !== null) {
    if (typeof raw.title !== "string") return 'an item "title" must be a string';
    title = cutTitle(raw.title);
  }
  let version: string | null = null;
  if (raw.version !== undefined && raw.version !== null) {
    if (typeof raw.version !== "string") return 'an item "version" must be a string';
    version = raw.version;
  }
  return { id: raw.id, title, version };
}

/** Output lines as a terminal would show them, trailing blank lines gone. */
function clean(text: string): string[] {
  const lines = stripAnsi(text).replace(/\r\n?/g, "\n").split("\n").map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A title past its limit, cut to it with an ellipsis, never inside a
 *  character written as two code units. */
function cutTitle(title: string): string {
  const max = SCHEDULE_LIMITS.itemTitleMaxChars;
  if (title.length <= max) return title;
  let end = max - 1;
  const code = title.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${title.slice(0, end)}…`;
}
