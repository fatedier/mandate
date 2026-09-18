import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const skill = readFileSync(path.join(process.cwd(), "src/server/modules/skills/builtins/canvas-artifact/SKILL.md"), "utf8");
const tools = readFileSync(path.join(process.cwd(), "src/server/modules/canvas/tool-packs.ts"), "utf8");

test("the canvas skill states checkable narrow-width rules", () => {
  expect(skill).toContain("## Narrow widths");
  for (const rule of [
    "No fixed pixel widths on layout containers",
    "grid-cols-1 sm:grid-cols-2",
    "overflow-x-auto",
    "min-w-[",
    "At 360px wide nothing overflows"
  ]) expect(skill).toContain(rule);
  expect(skill).not.toContain("It remains usable at narrow widths.");
});

test("the canvas_create description points at the narrow-width rules", () => {
  expect(tools).toContain("narrow-width rules");
});
