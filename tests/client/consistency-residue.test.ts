import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIRS = ["src/client/routes/activity", "src/client/routes/memory", "src/client/routes/settings", "src/client/routes/terminal", "src/client/routes/window/chat", "src/client/shell", "src/client/components"];
const FILES = ["src/client/routes/window/TmuxLayoutBoard.tsx", "src/client/routes/window/LayoutPane.tsx", "src/client/routes/window/PaneCardShell.tsx", "src/client/routes/window/PaneDetail.tsx", "src/client/routes/window/FeatureWorkItemDashboard.tsx", "src/client/routes/window/changes/ChangesTab.tsx", "src/client/routes/window/WindowPage.tsx", "src/client/routes/sessions/WindowDetailPage.tsx"];
// shadcn primitives: their hover / focus / open states are the primitives' own
// (button + toggle hover, menu + select item keyboard focus, dialog close), not
// page surfaces. Pages must not reach for bg-accent themselves.
const ALLOW = new Set([
  "src/client/components/ui/button.tsx",
  "src/client/components/ui/toggle.tsx",
  "src/client/components/ui/dialog.tsx",
  "src/client/components/ui/dropdown-menu.tsx",
  "src/client/components/ui/select.tsx"
]);
// `tracking-*`: the type ramp carries its own tracking (label-micro for an
// eyebrow); a hand-set token is a second opinion on it.
const BANNED = /\bbg-card\b|\bshadow-card\b|\bbg-accent\b|\bborder-primary\b|\bbg-primary\/(10|15|20)\b|\btracking-(wider|wide|tight|tighter|\[)/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

test("the old surface classes are gone from the pages this pass covers", () => {
  const files = [...DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...FILES.map((f) => path.join(ROOT, f))];
  const offenders: string[] = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    if (ALLOW.has(rel)) continue;
    const src = readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => { if (BANNED.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  expect(offenders).toEqual([]);
});

test("text-primary survives only as the markdown prose link and the button link variant", () => {
  const files = [...DIRS.flatMap((d) => walk(path.join(ROOT, d))), ...FILES.map((f) => path.join(ROOT, f))];
  // `(?!-)`: text-primary-foreground is a different token and not this residue.
  const hits = files.filter((f) => /\btext-primary(?!-)/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f)).sort();
  expect(hits).toEqual(["src/client/components/MarkdownView.tsx", "src/client/components/ui/button.tsx"]);
});
