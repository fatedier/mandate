import { isRecord } from "@shared/guards";
import { formatPayload } from "./parse";

/** How a tool's arguments and results are laid out when no view knows the
 *  tool: by the shape of each value, never by guessing from a key's name. */

const ACRONYMS = new Map([["id", "ID"], ["ids", "IDs"], ["url", "URL"], ["ui", "UI"], ["pr", "PR"], ["ms", "ms"]]);

/** A key as words: `phaseDetail` → "Phase detail", `fire_at` → "Fire at",
 *  `paneId` → "Pane ID". Keys are the model's API, not the reader's. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => ACRONYMS.get(word) ?? word);
  if (words.length === 0) return key;
  const first = words[0]!;
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

/** Past this length, or with a line break, a string is something someone
 *  wrote — a message, a note, a summary — and gets the full width to wrap in,
 *  not a cell in a key column. Notes and
 *  summaries usually run longer than this; ids, paths' tails and enum values stay
 *  well under. */
const PROSE_MIN_LENGTH = 60;

export type Scalar = string | number | boolean | null;

/** `key` is the path to the value: one key, or two for a field of an object
 *  argument (`patch.title`). */
type ArgPart =
  | { kind: "option"; key: string[]; value: Scalar }
  | { kind: "prose"; key: string[]; value: string }
  | { kind: "list"; key: string[]; value: string[] }
  | { kind: "data"; key: string[]; value: unknown };

export function isProse(value: string): boolean {
  return value.length > PROSE_MIN_LENGTH || value.includes("\n");
}

/** One call's arguments, each placed by its shape: short values to one
 *  compact grid, writing to a section of its own, a list of strings as a
 *  list. An object argument (`patch: { title, summary }`) is opened one level,
 *  its fields placed the same way; anything deeper is formatted JSON. A null
 *  is kept — `needsUser: null` is how a patch clears a field. Arguments that
 *  are not an object at all (a malformed call's `null` included) are one
 *  JSON part. */
export function argParts(args: unknown, skip: ReadonlySet<string> = new Set()): ArgPart[] {
  if (args === undefined) return [];
  if (!isRecord(args)) return [{ kind: "data", key: ["arguments"], value: args }];
  const parts: ArgPart[] = [];
  const place = (key: string[], value: unknown, open: boolean) => {
    if (value === undefined) return;
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      parts.push({ kind: "option", key, value });
    } else if (typeof value === "string") {
      parts.push(isProse(value) ? { kind: "prose", key, value } : { kind: "option", key, value });
    } else if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string")) {
      parts.push({ kind: "list", key, value: value as string[] });
    } else if (open && isRecord(value) && Object.keys(value).length > 0) {
      for (const [field, inner] of Object.entries(value)) place([...key, field], inner, false);
    } else {
      parts.push({ kind: "data", key, value });
    }
  };
  for (const [key, value] of Object.entries(args)) {
    if (!skip.has(key)) place([key], value, true);
  }
  return parts;
}

/** A part's key as its label: "Patch · Title" for a field of an argument. */
export function partLabel(key: string[]): string {
  return key.map(humanizeKey).join(" · ");
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** An ISO date and time that names a real moment. `Date.parse` rejects a
 *  month, minute or second out of range, but rolls a day past the month's
 *  end over (February 30th reads as March 2nd) and takes hour 24 as the next
 *  day — measured — and a malformed date shown as a different, valid-looking
 *  one would mislead. Those two are checked here. */
export function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP.exec(value);
  if (!match) return false;
  const [year, month, day, hour] = match.slice(1, 5).map(Number);
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  return day! <= daysInMonth && hour! <= 23 && Number.isFinite(Date.parse(value));
}

export function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** A result that only says it worked — `{ ok: true }` — adds nothing to the
 *  call's status, so it takes no section. */
export function isBareAck(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 1 && value.ok === true;
}

/** The fields worth a line in a list item: the first of these that is text
 *  names the item. */
const TITLE_KEYS = [
  "title", "name", "label", "featureName", "content", "summary", "snippet", "note", "message", "text", "query", "path", "command"
];

interface ItemSummary {
  title: string | null;
  titleKey: string | null;
  id: string | null;
  meta: Array<[string, Scalar]>;
}

const META_MAX = 3;
const META_MAX_LENGTH = 40;

/** One record in a list, as a line: a title, its id, and a few short fields
 *  beside them. The rest stays in the raw JSON. */
export function itemSummary(item: Record<string, unknown>): ItemSummary {
  const titleKey = TITLE_KEYS.find((key) => typeof item[key] === "string" && (item[key] as string).trim()) ?? null;
  const idKey = Object.keys(item).find((key) => (key === "id" || /[a-z]Id$/.test(key)) && typeof item[key] === "string") ?? null;
  const meta: Array<[string, Scalar]> = [];
  for (const [key, value] of Object.entries(item)) {
    if (meta.length >= META_MAX) break;
    if (key === titleKey || key === idKey || value === null || !isScalar(value)) continue;
    if (typeof value === "string" && (!value.trim() || value.length > META_MAX_LENGTH)) continue;
    meta.push([key, value]);
  }
  return {
    title: titleKey ? (item[titleKey] as string) : null,
    titleKey,
    id: idKey ? (item[idKey] as string) : null,
    meta
  };
}

/** Past this many levels down a laid-out value is shown as JSON. */
export const MAX_DEPTH = 2;

/** About how many lines a value takes laid out (StructuredValue): a field a
 *  line, a list item two, a heading one, JSON its own lines. */
export function layoutRows(value: unknown, depth = 0): number {
  if (Array.isArray(value)) {
    return value.length === 0 ? 1 : value.reduce<number>((rows, item) => rows + (isRecord(item) ? 2 : 1), 0);
  }
  if (!isRecord(value) || depth > MAX_DEPTH) return formatPayload(value).split("\n").length;
  let rows = 0;
  for (const field of Object.values(value)) {
    if (field === undefined) continue;
    if (isScalar(field) || (Array.isArray(field) && field.every(isScalar))) rows += 1;
    else rows += 1 + layoutRows(field, depth + 1);
  }
  return Math.max(rows, 1);
}
