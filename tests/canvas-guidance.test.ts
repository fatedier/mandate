import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { canvasCreateDescription, canvasPageContract } from "../src/server/modules/canvas/canvas-contract.js";
import { CANVAS_FONT_SOURCES, CANVAS_SCRIPT_SOURCES, CANVAS_STYLE_SOURCES } from "../src/shared/canvas-page.js";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const skill = read("src/server/modules/skills/builtins/canvas-artifact/SKILL.md");
const manager = read("src/server/modules/agent/prompts/manager.md");
const worker = read("src/server/modules/agent/prompts/worker.md");

/** The old one-look rules that made every report the same. */
const OLD_RULES = [
  "dark background", "Linear", "Vercel", "Stripe", "shipped product surface", "Namespace",
  "canvas-verdict-card", "canvas-patched-result", "Tailwind classes work out of the box",
  "sizes itself", "min-h-screen", "bg-card", "bg-background", "narrow-width rules", "anti-ai-slop"
];

test("canvas_create's description is the page contract plus the scope sentence", () => {
  const contract = canvasPageContract();
  for (const host of [...CANVAS_SCRIPT_SOURCES, ...CANVAS_STYLE_SOURCES, ...CANVAS_FONT_SOURCES]) {
    expect(contract).toContain(host);
  }
  for (const rule of [
    ':root:not([data-theme="light"])', ':root[data-theme="dark"]', "color-scheme: dark",
    '<meta name="viewport" content="width=1280">', "600 to 2560", "16MB", "first 8KB",
    "`canvas-artifact` skill", "canvas_outline", "canvas_remove_section", "conclusion first",
    "A Web Worker starts only from a `blob:` URL",
    "Two things cannot come from that folder, fonts and ES modules",
    "the browser merges its tags into the skeleton",
    // The base rules the viewer's skeleton sets, scrollbars among them.
    "thin scrollbars in a grey that reads on a light or a dark page",
    "`navigator.clipboard` may be absent",
    "the PDF may come up blank and the HTML page will not run its scripts"
  ]) {
    expect(contract).toContain(rule);
  }
  expect(canvasCreateDescription(true).startsWith(contract)).toBe(true);
  expect(canvasCreateDescription(true)).toContain("note of the plan step");
  expect(canvasCreateDescription(false)).toContain("Optionally pass projectId");
});

test("the report skill is the design guidance and does not repeat the contract", () => {
  for (const heading of ["## How much design", "## Rules for every report", "## Before you write", "## Before you publish", "## In Mandate", "## When it should stand out"]) {
    expect(skill).toContain(heading);
  }
  for (const rule of ["**Draw charts to scale.**", "**Looks to stay away from.**", "**Design both themes.**", "canvas_create", "canvas_outline", "what they change is not kept"]) {
    expect(skill).toContain(rule);
  }
  for (const absent of ["## Page contract", "read, not operated", "rejected proposals", "put next to index.html and referenced by relative path"]) {
    expect(skill).not.toContain(absent);
  }
});

test("both prompts point report writing at the skill", () => {
  expect(manager).toContain("Load the `canvas-artifact` skill before writing a report");
  expect(worker).toContain("Load the `canvas-artifact` skill before writing a report");
  expect(worker).toContain("note of the step it belongs to");
  const workerTools = worker.slice(0, worker.indexOf("## Guidelines"));
  expect(workerTools).toContain("canvas_outline");
  expect(workerTools).toContain("canvas_remove_section");
  expect(skill).toContain("a page that is one theme on purpose is excused");
});

test("none of the old one-look rules survive", () => {
  const sources = { contract: canvasPageContract(), skill, manager, worker };
  const hits = Object.entries(sources).flatMap(([name, text]) => OLD_RULES.filter((rule) => text.includes(rule)).map((rule) => `${name}: ${rule}`));
  expect(hits).toEqual([]);
  expect(fs.existsSync(path.join(root, "src/server/modules/skills/builtins/canvas-artifact/references"))).toBe(false);
});

test("canvas_create's description points designs at the canvas-design skill", () => {
  for (const description of [canvasCreateDescription(true), canvasCreateDescription(false)]) {
    expect(description).toContain('pass kind "design" and load the `canvas-design` skill first');
    expect(description).toContain("shown at its fixed size, is one look for every viewer (it gets no theme: skip the contract's dark blocks and write no prefers-color-scheme rule; publish warns), and needs no `<title>`: canvas.json's `title` names the canvas");
  }
});

const designSkill = read("src/server/modules/skills/builtins/canvas-design/SKILL.md");
const designCraft = read("src/server/modules/skills/builtins/canvas-design/references/craft.md");
const designQuestions = read("src/server/modules/skills/builtins/canvas-design/references/questions.md");

test("the canvas-design skill names an artboard in canvas.json, not with a <title>", () => {
  // The viewer labels a frame with boards[path].title or the file name; an
  // artboard's own <title> names nothing.
  expect(designSkill).toContain("an artboard needs no `<title>`: its frame is named by its board's `title`");
  expect(designSkill).toContain('"Main.html":{"x":0,"y":0,"w":390,"h":844,"title":"Cart"}');
  expect(designSkill).not.toContain("your own `<title>` naming the screen");
  expect(designSkill).not.toContain("<title>Cart</title>");
});

test("the canvas-design skill's example is a working prototype and its size limit names what counts", () => {
  // Main.html links to Checkout.html, so the index lists it: only listed boards are prototype links.
  expect(designSkill).toContain('<a class="cta" href="Checkout.html">');
  expect(designSkill).toContain('"Checkout.html":{"x":470,"y":0,"w":390,"h":844,"title":"Checkout"}');
  expect(designSkill).toContain('"order":["Main.html","Checkout.html"]');
  expect(designSkill).toContain("canvas.json and its artboard pages over 16 MB together (support files beside them don't count)");
});

test("the canvas-design skill covers HTML artboards with Mandate's tools, and its references the craft and the questions", () => {
  expect(designSkill).toMatch(/^---\nname: canvas-design\n/);
  for (const heading of ["## Creating", "## The files: exact shapes", "## One artboard", "## Revising", "## Designing well"]) {
    expect(designSkill).toContain(heading);
  }
  for (const rule of [
    'canvas_create` with `kind: "design"`', "canvas_publish", "`canvas.json`", "frames 80 px apart within a row and rows 120 px apart",
    "`is_interactive`", "`expand`", "`title1`", "phone 390×844", "FIXED size", "one look for every viewer", "`prefers-color-scheme`", "Tailwind `dark:`", "`light-dark()`",
    "**Do not check your work unless asked.**", "references/craft.md", "references/questions.md"
  ]) {
    expect(designSkill).toContain(rule);
  }
  for (const kept of ["## Where the look comes from", "### From the product", "## Options", "## Drawing the screens", "**Accessible as drawn.**", "**Phone screens.**", "### Redrawing an interface that exists", "## Content rules"]) {
    expect(designCraft).toContain(kept);
  }
  expect(designQuestions).toContain("# Ask before you build");
});
