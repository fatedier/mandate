/** Keys whose value is the point of the call. Showing the value alone beats
 *  showing the JSON that wraps it — `git status --short` rather than
 *  `{"command":"git status --short"`, which spends the first characters of a
 *  truncated preview on syntax.
 *
 *  `id` and `featureId` used to be in here and are deliberately not: they name
 *  which record was acted on, never what happened, so promoting them spent the
 *  whole row on a string nobody can read. */
const PRIMARY_ARG_KEYS = [
  "command", "path", "file_path", "filePath", "query", "pattern",
  "url", "prompt", "content", "title", "name"
];

const SUMMARY_MAX = 240;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bare tmux pane. Bare is the whole point: `%42_zsh_/Users/alice/project` carries
 *  the working directory and is worth reading, so it must not match. */
const BARE_PANE = /^%\d+$/;
/** `task_AbCd12Ef_Gh`, `mem_JkLm34NoPqR`, `cnv_StUv56WxYzA`. The lookahead is what
 *  separates a generated id from ordinary snake_case: `newId` spends 8 random
 *  bytes through base64url, so an uppercase letter is all but certain (sampling
 *  the real generator 200k times, 0.32% of ids carry none), while
 *  `read_only_mode` and `pane_output` carry none by construction.
 *
 *  A `(?=\D*\d)` lookahead used to sit alongside it and was removed: 14.8% of
 *  ids from that same sample carry no digit at all, so it lost one id in seven
 *  while sparing exactly one non-id string across the whole repository — which
 *  was itself an id. */
const PREFIXED_ID = /^[a-z]{2,6}_(?=[A-Za-z0-9_-]{8,}$)(?=[^A-Z]*[A-Z])[A-Za-z0-9_-]+$/;

/** Values a reader cannot learn anything from. Shape decides, never the key
 *  name: `id` holds both `feature/preference` and a UUID in this database. */
export function isOpaqueId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return UUID.test(value) || BARE_PANE.test(value) || PREFIXED_ID.test(value);
}

export function argEntries(args: unknown): [string, unknown][] | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  // Unset optionals arrive as null/"" and were taking a row each — on a tool with
  // nine parameters that buried the two that were actually passed.
  const entries = Object.entries(args as Record<string, unknown>)
    .filter(([, value]) => value !== null && value !== undefined && value !== "");
  return entries.length > 0 ? entries : null;
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return String(value);
  // Only when every element is a string, because space-joining anything else
  // produces `1 [object Object]`, which cannot be read back.
  if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string")) {
    return value.join(" ");
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

function cap(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;
  // `slice` counts UTF-16 units, so a boundary landing between the two halves of
  // a surrogate pair cuts an emoji down the middle and leaves a lone surrogate
  // that renders as a replacement glyph. Back off one unit when that happens —
  // which also keeps the result within the cap rather than overshooting it.
  const first = text.charCodeAt(SUMMARY_MAX - 1);
  const end = first >= 0xd800 && first <= 0xdbff ? SUMMARY_MAX - 1 : SUMMARY_MAX;
  return `${text.slice(0, end)}…`;
}

/** One line for a collapsed tool row. `canvasTitle` is used only when nothing
 *  else survives — a title from the call's own result, so it is the name the
 *  canvas had when this ran rather than whatever it is called today. */
export function summarizeArgs(args: unknown, canvasTitle?: string | null): string {
  const fallback = canvasTitle?.trim() ?? "";
  if (args == null) return fallback;
  if (typeof args === "string") return cap(args) || fallback;

  const entries = argEntries(args);
  if (!entries) return cap(valueText(args)) || fallback;

  const meaningful = entries.filter(([, value]) => !isOpaqueId(value));
  if (meaningful.length === 0) return fallback;

  const primary = meaningful.find(
    ([key, value]) => PRIMARY_ARG_KEYS.includes(key) && typeof value === "string" && value !== ""
  );
  if (primary) return cap(String(primary[1]));

  // Drop entries whose VALUE renders empty. Testing the joined `key=value` for a
  // trailing `=` instead looked equivalent and was not: it took out any entry
  // whose value ends in `=` — a markdown setext underline (`====`) or a padded
  // base64 payload, both of which occur in a work-item body.
  return cap(
    meaningful
      .map(([key, value]) => [key, valueText(value)] as const)
      .filter(([, text]) => text !== "")
      .map(([key, text]) => `${key}=${text}`)
      .join("  ")
  );
}
