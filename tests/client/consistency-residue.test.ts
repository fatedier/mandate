import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "../helpers/source-files.js";

const ROOT = process.cwd();
const DIRS = ["src/client/routes/activity", "src/client/routes/memory", "src/client/routes/settings", "src/client/routes/terminal", "src/client/routes/window/chat", "src/client/shell", "src/client/components", "src/client/routes/window/plan", "src/client/routes/canvas"];
const FILES = ["src/client/routes/window/TmuxLayoutBoard.tsx", "src/client/routes/window/LayoutPane.tsx", "src/client/routes/window/PaneCardShell.tsx", "src/client/routes/window/PaneDetail.tsx", "src/client/routes/window/changes/ChangesTab.tsx", "src/client/routes/window/WindowPage.tsx", "src/client/routes/sessions/WindowDetailPage.tsx"];
// shadcn primitives: their hover / open states are the primitives' own (button
// hover, dialog close), not page surfaces. Pages must not reach for bg-accent
// themselves. The menus, select and toggle are not here: accent is the
// popover's colour give or take a shade in the dark theme (#232326 on
// #26262a), so a highlighted item or a checked preset was invisible there.
// They use bg-sel.
const ALLOW = new Set([
  "src/client/components/ui/button.tsx",
  "src/client/components/ui/dialog.tsx"
]);
// `tracking-*`: the type ramp carries its own tracking (label-micro for an
// eyebrow); a hand-set token is a second opinion on it.
const BANNED = /\bbg-card\b|\bshadow-card\b|\bbg-accent\b|\bborder-primary\b|\bbg-primary\/(10|15|20)\b|\btracking-(wider|wide|tight|tighter|\[)/;

test("the old surface classes are gone from these pages", () => {
  const files = [...DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d), /\.tsx?$/)), ...FILES.map((f) => path.join(ROOT, f))];
  const offenders: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (ALLOW.has(rel)) continue;
    const src = readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => { if (BANNED.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  expect(offenders).toStrictEqual([]);
});

test("text-primary survives only as the markdown prose link and the button link variant", () => {
  const files = [...DIRS.flatMap((d) => sourceFiles(path.join(ROOT, d), /\.tsx?$/)), ...FILES.map((f) => path.join(ROOT, f))];
  // `(?!-)`: text-primary-foreground is a different token and not this residue.
  const hits = files.filter((f) => /\btext-primary(?!-)/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)).sort();
  expect(hits).toEqual(["src/client/components/MarkdownView.tsx", "src/client/components/ui/button.tsx"]);
});

// Group headers in lists and navigation are sentence case at the rows' size,
// ranked by weight and colour (label-group); label-micro's caps are for table
// heads, chips and field labels. Caps in a navigation column read as a data
// table.
const GROUP_HEADER_FILES = [
  "src/client/shell/ThreadsNavSection.tsx",
  "src/client/shell/Sidebar.tsx",
  "src/client/routes/threads/WorkersOverview.tsx",
  "src/client/routes/memory/dream/ActivityView.tsx",
  "src/client/routes/home/WaitingOnYou.tsx",
  "src/client/routes/terminal/PaneSwitcherSheet.tsx"
];

test("group headers in lists and navigation use label-group, never label-micro", () => {
  const css = readFileSync(path.join(ROOT, "src/client/styles/globals.css"), "utf8");
  const rule = /\.label-group \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect({ size: /font-size: var\(--text-xs\)/.test(rule), weight: /font-weight: 600/.test(rule), caps: /text-transform/.test(rule) })
    .toEqual({ size: true, weight: true, caps: false });
  for (const f of GROUP_HEADER_FILES) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    expect({ f, micro: /\blabel-micro\b/.test(src), group: /\blabel-group\b/.test(src) }).toEqual({ f, micro: false, group: true });
  }
});

// A busy label ("Saving…") ends in the ellipsis character: never three full
// stops, never nothing. The second pattern is a label swap whose idle side is
// a capitalised string ("Signing out…" : "Sign out"); a heading that swaps
// on a state is not a busy label.
const NOT_BUSY_LABELS = new Set(['"Dreaming now" : "Last dream"']);

test("busy labels end in the ellipsis character", () => {
  const offenders: string[] = [];
  for (const f of sourceFiles(path.join(ROOT, "src/client"), /\.tsx?$/)) {
    const rel = path.relative(ROOT, f);
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const swap = /\? ("[A-Z][a-z]+ing(?: [a-z]+)?" : "[A-Z][^"]*")/.exec(line);
      if (/[A-Za-z]\.\.\.["'`]/.test(line) || (swap && !NOT_BUSY_LABELS.has(swap[1]!))) {
        offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
      }
    });
  }
  expect(offenders).toStrictEqual([]);
});
