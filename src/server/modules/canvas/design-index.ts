import { z } from "zod";
import type { DesignBoard, DesignIndex, DesignLaunch, DesignNote, DesignPage } from "../../../shared/api-contracts.js";
import { errorText } from "../../../shared/error-text.js";

/**
 * A design canvas's index, canvas.json: the keys the viewer uses. Parsed with JSON.parse and zod; unknown
 * keys are accepted and ignored. What makes the canvas unreadable is refused;
 * everything else is normalized with a warning.
 */

/** Segments joined by `/`. A segment begins with a letter, a digit or `_`
 *  and goes on with those, `.` and `-`; the path ends in `.html`. Never `..`,
 *  a leading `/`, `\` or a space. */
const DESIGN_BOARD_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*\.html$/;
const DESIGN_SIDE_MIN = 40;
const DESIGN_SIDE_MAX = 8000;
const DESIGN_PAGES_MAX = 40;
const DESIGN_NOTES_MAX = 200;
const DESIGN_DEFAULT_PAGE = "main";
const ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Only the frame is required; the optional fields are read one by one, so
 *  a wrong type (`title: null`) is ignored with a warning, not a refusal. */
const boardSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number()
});
/** As for a board, only the place and text are required: an optional field
 *  that is null or not a value a note takes is ignored with a warning. */
const noteSchema = z.looseObject({
  x: z.number(),
  y: z.number(),
  text: z.string()
});
const NOTE_SIZES = new Set(["s", "m", "l", "xl", "xxl"]);
const NOTE_FILLS = new Set(["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"]);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
/** A size name, or px as a number or "24px". */
function readNoteSize(v: unknown): string | number | undefined {
  if (typeof v === "string" && NOTE_SIZES.has(v)) return v;
  if (positive(v)) return v;
  const px = typeof v === "string" ? /^(\d+(?:\.\d+)?)px$/.exec(v.trim()) : null;
  return px && Number(px[1]) > 0 ? Number(px[1]) : undefined;
}
const pageSchema = z.looseObject({ id: z.string().regex(ID), name: z.string() });
const launchSchema = z.union([
  z.looseObject({ view: z.literal("canvas"), page: z.string().optional() }),
  z.looseObject({ view: z.literal("focused"), file: z.string() })
]);
const indexSchema = z.looseObject({
  title: z.unknown().optional(),
  boards: z.record(z.string(), z.unknown()),
  order: z.unknown().optional(),
  pages: z.unknown().optional(),
  notes: z.unknown().optional(),
  launch: z.unknown().optional()
});

type ParsedDesignIndex = { index: DesignIndex; warnings: string[] } | { error: string };

export function parseDesignIndex(text: string): ParsedDesignIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { error: `canvas.json is not valid JSON: ${errorText(err)}` };
  }
  const top = indexSchema.safeParse(raw);
  if (!top.success) return { error: `canvas.json must be an object with a "boards" object: ${firstIssue(top.error)}` };
  const doc = top.data;
  const warnings: string[] = [];
  let title: string | null = null;
  if (typeof doc.title === "string") title = doc.title.trim() || null;
  else if (doc.title !== undefined) warnings.push('"title" is not a string; it is ignored.');

  const pages = readPages(doc.pages, warnings);
  const pageIds = new Set(pages.map((page) => page.id));
  const firstPage = pages[0]!.id;

  const paths = Object.keys(doc.boards);
  if (!paths.length) return { error: 'canvas.json lists no artboards: add one to "boards", keyed by its file\'s path.' };
  const byPath = new Map<string, DesignBoard>();
  for (const path of paths) {
    if (!DESIGN_BOARD_PATH.test(path)) {
      return { error: `"${path}" is not an artboard path: a segment begins with a letter, a digit or "_" and goes on with those, "." and "-"; no spaces, and the path ends in ".html".` };
    }
    const entry = boardSchema.safeParse(doc.boards[path]);
    if (!entry.success) return { error: `"${path}": x, y, w and h must be numbers (${firstIssue(entry.error)}).` };
    const board = entry.data;
    const raw = doc.boards[path] as Record<string, unknown>;
    const wrong: string[] = [];
    const boardTitle = optional(raw, "title", (v): v is string => typeof v === "string", wrong);
    const boardPage = optional(raw, "page", (v): v is string => typeof v === "string", wrong);
    const interactive = optional(raw, "is_interactive", (v): v is boolean => typeof v === "boolean", wrong);
    const radius = optional(raw, "radius", (v): v is number => typeof v === "number" && Number.isFinite(v), wrong);
    // The one value expand takes; null reads as absent.
    const expand = optional(raw, "expand", (v): v is "fill" | null => v === "fill" || v === null, wrong);
    if (wrong.length) warnings.push(`"${path}": ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not the right type; ${wrong.length === 1 ? "it is" : "they are"} ignored.`);
    let page = boardPage ?? firstPage;
    if (!pageIds.has(page)) {
      warnings.push(`"${path}" names page "${page}", which is not in "pages"; it shows on the first page.`);
      page = firstPage;
    }
    const w = clamp(board.w, DESIGN_SIDE_MIN, DESIGN_SIDE_MAX);
    const h = clamp(board.h, DESIGN_SIDE_MIN, DESIGN_SIDE_MAX);
    if (w !== board.w || h !== board.h) {
      warnings.push(`"${path}" is ${board.w}×${board.h}: an artboard's w and h are ${DESIGN_SIDE_MIN}–${DESIGN_SIDE_MAX} px.`);
    }
    byPath.set(path, {
      path,
      x: board.x,
      y: board.y,
      w,
      h,
      title: boardTitle?.trim() || null,
      page,
      expand: expand ?? null,
      interactive: interactive === true,
      radius: Math.max(0, radius ?? 0)
    });
  }

  const boards = orderBoards(byPath, doc.order, warnings);
  const notes = readNotes(doc.notes, pageIds, firstPage, warnings);
  const launch = readLaunch(doc.launch, byPath, pageIds, firstPage, warnings);
  overlapWarnings(boards, warnings);
  return { index: { title, pages, boards, notes, launch }, warnings };
}

function readPages(raw: unknown, warnings: string[]): DesignPage[] {
  const pages: DesignPage[] = [];
  const seen = new Set<string>();
  if (raw !== undefined && !Array.isArray(raw)) warnings.push('"pages" is not a list; the canvas has one page.');
  for (const entry of Array.isArray(raw) ? raw : []) {
    const page = pageSchema.safeParse(entry);
    if (!page.success) {
      const id = typeof (entry as { id?: unknown })?.id === "string" ? (entry as { id: string }).id : "?";
      warnings.push(`Page "${id}" is skipped: a page is {"id","name"} with an id of letters, digits, "_" or "-" (at most 40).`);
      continue;
    }
    if (seen.has(page.data.id)) {
      warnings.push(`Page "${page.data.id}" is listed twice; the second is skipped.`);
      continue;
    }
    seen.add(page.data.id);
    pages.push({ id: page.data.id, name: page.data.name });
  }
  if (pages.length > DESIGN_PAGES_MAX) {
    warnings.push(`"pages" has ${pages.length} entries; only the first ${DESIGN_PAGES_MAX} are kept.`);
    pages.length = DESIGN_PAGES_MAX;
  }
  return pages.length ? pages : [{ id: DESIGN_DEFAULT_PAGE, name: "" }];
}

function orderBoards(byPath: Map<string, DesignBoard>, order: unknown, warnings: string[]): DesignBoard[] {
  if (order === undefined) return [...byPath.values()];
  if (!Array.isArray(order)) {
    warnings.push('"order" is not a list of paths; the boards keep their canvas.json order.');
    return [...byPath.values()];
  }
  const boards: DesignBoard[] = [];
  const placed = new Set<string>();
  for (const path of order) {
    if (typeof path !== "string") {
      warnings.push('"order" has an entry that is not a string; it is skipped.');
      continue;
    }
    const board = byPath.get(path);
    if (!board) {
      warnings.push(`"order" names "${path}", which is not in "boards".`);
      continue;
    }
    if (placed.has(path)) continue;
    placed.add(path);
    boards.push(board);
  }
  for (const board of byPath.values()) {
    if (placed.has(board.path)) continue;
    warnings.push(`"${board.path}" is in "boards" but not in "order"; it is drawn last.`);
    boards.push(board);
  }
  return boards;
}

function readNotes(raw: unknown, pageIds: Set<string>, firstPage: string, warnings: string[]): DesignNote[] {
  const notes: DesignNote[] = [];
  const isObject = typeof raw === "object" && raw !== null && !Array.isArray(raw);
  if (raw !== undefined && !isObject) warnings.push('"notes" is not an object of notes; there are none.');
  const entries = isObject ? Object.entries(raw) : [];
  for (const [id, entry] of entries) {
    // Hand-drawn shapes (rect, oval, pen…) are not notes here,
    // and need no text or id rule: they are dropped before any check.
    const kind = (entry as { kind?: unknown } | null)?.kind;
    if (typeof kind === "string" && kind !== "title1") continue;
    if (!ID.test(id)) {
      warnings.push(`Note "${id}" is skipped: note ids are letters, digits, "_" or "-" (at most 40).`);
      continue;
    }
    const note = noteSchema.safeParse(entry);
    if (!note.success) {
      warnings.push(`Note "${id}" is skipped: a note needs numbers x and y and a string text.`);
      continue;
    }
    const value = note.data;
    const raw = entry as Record<string, unknown>;
    const wrong: string[] = [];
    const field = <T>(key: string, read: (v: unknown) => T | undefined): T | undefined => {
      if (raw[key] === undefined || raw[key] === null) return undefined;
      const result = read(raw[key]);
      if (result === undefined) wrong.push(key);
      return result;
    };
    const w = field("w", (v) => (positive(v) ? v : undefined));
    const maxW = field("maxW", (v) => (positive(v) ? v : undefined));
    const maxH = field("maxH", (v) => (positive(v) ? v : undefined));
    const size = field("size", readNoteSize);
    const bold = field("bold", (v) => (typeof v === "boolean" ? v : undefined));
    const italic = field("italic", (v) => (typeof v === "boolean" ? v : undefined));
    const color = field("color", (v) => (typeof v === "string" ? v : undefined));
    const fill = field("fill", (v) => (typeof v === "string" && NOTE_FILLS.has(v) ? v : undefined));
    const notePage = field("page", (v) => (typeof v === "string" ? v : undefined));
    if (wrong.length) warnings.push(`Note "${id}": ${wrong.join(", ")} ${wrong.length === 1 ? "is" : "are"} not valid for a note; ${wrong.length === 1 ? "it is" : "they are"} ignored.`);
    let page = notePage ?? firstPage;
    if (!pageIds.has(page)) {
      warnings.push(`Note "${id}" names page "${page}", which is not in "pages"; it shows on the first page.`);
      page = firstPage;
    }
    notes.push({
      id,
      kind: kind === "title1" ? "title1" : "sticky",
      x: value.x,
      y: value.y,
      text: value.text,
      page,
      w: w ?? null,
      maxW: maxW ?? null,
      maxH: maxH ?? null,
      size: size ?? null,
      bold: bold === true,
      italic: italic === true,
      color: color ?? null,
      fill: fill ?? null
    });
  }
  if (notes.length > DESIGN_NOTES_MAX) {
    warnings.push(`"notes" has ${notes.length} entries; only the first ${DESIGN_NOTES_MAX} are kept.`);
    notes.length = DESIGN_NOTES_MAX;
  }
  return notes;
}

function readLaunch(raw: unknown, byPath: Map<string, DesignBoard>, pageIds: Set<string>, firstPage: string, warnings: string[]): DesignLaunch {
  if (raw === undefined) return { view: "canvas", page: firstPage };
  const launch = launchSchema.safeParse(raw);
  if (!launch.success) {
    warnings.push('"launch" is not {"view":"canvas"} or {"view":"focused","file":…}; the canvas opens on its first page.');
    return { view: "canvas", page: firstPage };
  }
  if (launch.data.view === "focused") {
    if (byPath.has(launch.data.file)) return { view: "focused", path: launch.data.file };
    warnings.push(`"launch" opens "${launch.data.file}", which is not in "boards"; the canvas opens on its first page.`);
    return { view: "canvas", page: firstPage };
  }
  const page = launch.data.page ?? firstPage;
  if (pageIds.has(page)) return { view: "canvas", page };
  warnings.push(`"launch" opens page "${page}", which is not in "pages"; the canvas opens on its first page.`);
  return { view: "canvas", page: firstPage };
}

/** Pairs named one per line; frames stacked on one spot would name every pair. */
const OVERLAP_LINES = 5;

function overlapWarnings(boards: DesignBoard[], warnings: string[]): void {
  let pairs = 0;
  for (let i = 0; i < boards.length; i++) {
    for (let j = i + 1; j < boards.length; j++) {
      const a = boards[i]!;
      const b = boards[j]!;
      if (a.page !== b.page) continue;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapX > 0 && overlapY > 0) {
        pairs += 1;
        if (pairs <= OVERLAP_LINES) warnings.push(`"${a.path}" and "${b.path}" overlap on the canvas: keep frames 80 px apart within a row and rows 120 px apart.`);
      }
    }
  }
  if (pairs > OVERLAP_LINES) warnings.push(`${pairs - OVERLAP_LINES} more pairs of frames overlap: give each frame its own x and y.`);
}

/** An optional field's value when it has the right type; a present value of
 *  another type is named in `wrong` and ignored. */
function optional<T>(raw: Record<string, unknown>, key: string, check: (value: unknown) => value is T, wrong: string[]): T | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (check(value)) return value;
  wrong.push(key);
  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  return issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}
