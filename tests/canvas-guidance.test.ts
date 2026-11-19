import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { canvasDescription, canvasPageContract } from "../src/server/modules/canvas/canvas-contract.js";
import { buildSkillTool } from "../src/server/modules/skills/skill-tool.js";
import type { ToolContext } from "../src/server/modules/agent/tool-registry.js";
import { bootstrapSkills } from "../src/server/runtime/skills-bootstrap.js";
import { CANVAS_FONT_SOURCES, CANVAS_SCRIPT_SOURCES, CANVAS_STYLE_SOURCES } from "../src/shared/canvas-page.js";
import { stub } from "./helpers/typed.js";

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

test("the page contract comes with both canvas skills, not in the canvas tool's description", async () => {
  const contract = canvasPageContract();
  for (const host of [...CANVAS_SCRIPT_SOURCES, ...CANVAS_STYLE_SOURCES, ...CANVAS_FONT_SOURCES]) {
    expect(contract).toContain(host);
  }
  for (const rule of [
    ':root:not([data-theme="light"])', ':root[data-theme="dark"]', "color-scheme: dark",
    '<meta name="viewport" content="width=1280">', "600 to 2560", "16MB", "first 8KB",
    "the `canvas` tool's outline lists its top-level blocks and their size, remove_section drops one, and one publish renders the result",
    "It is read from the first 8KB of the file at every publish",
    // What goes on the page: read in a minute or two, evidence folded, rewritten as things stand.
    "The page is read in a minute or two", "in a closed `<details>` block, or leave it out", "rewrite it as things stand now",
    "A Web Worker starts only from a `blob:` URL",
    "Two things cannot come from that folder, fonts and ES modules",
    "the browser merges its tags into the skeleton",
    // The base rules the viewer's skeleton sets, scrollbars among them.
    "thin scrollbars in a grey that reads on a light or a dark page",
    "`img{max-width:100%;object-fit:contain}`",
    "`navigator.clipboard` may be absent",
    "the PDF may come up blank and the HTML page will not run its scripts"
  ]) {
    expect(contract).toContain(rule);
  }
  expect(contract.startsWith("## The page contract\n\n")).toBe(true);

  // Loaded as the app loads skills, each canvas skill ends with the contract, for every scope that makes canvases.
  const userSkills = fs.mkdtempSync(path.join(os.tmpdir(), "md-canvas-skills-"));
  try {
    const { registry } = await bootstrapSkills({ builtinSkillsDir: path.join(root, "src/server/modules/skills/builtins"), userSkillsDir: userSkills, extraSkillsDirs: [] });
    for (const scope of ["worker", "manager", "personal"] as const) {
      const skillTool = buildSkillTool(registry, scope);
      const report = String(await skillTool.handler({ name: "canvas-artifact" }, stub<ToolContext>()));
      const design = String(await skillTool.handler({ name: "canvas-design" }, stub<ToolContext>()));
      expect(report).toContain("# Designing a report");
      expect(design).toContain("# Design canvases");
      for (const loaded of [report, design]) expect(loaded).toContain(`${contract}\n</system-reminder>`);
    }
  } finally {
    fs.rmSync(userSkills, { recursive: true, force: true });
  }

  for (const description of [canvasDescription(true), canvasDescription(false)]) {
    expect(description).toContain("load the `canvas-artifact` skill: it holds the page contract (what the viewer does with the page, and what it will not do) and the design guidance");
    for (const part of ["**What you write**", "**What loads**", "**Inside the frame**", "**Light and dark**", "cdnjs.cloudflare.com"]) expect(description).not.toContain(part);
  }
  expect(canvasDescription(true)).toContain("note of the plan step");
  expect(canvasDescription(false)).toContain("Give projectId to store it under a project");
});

test("the report skill is the design guidance and does not repeat the contract", () => {
  for (const heading of ["## What goes on the page", "## How much design", "## Rules for every report", "## Before you write", "## Before you publish", "## In Mandate", "## When it should stand out"]) {
    expect(skill).toContain(heading);
  }
  for (const rule of [
    "**The first screen**", "**Show it rather than tell it.**", "**Folded**", "**When the long part is the point**", "**When it changes**",
    "**Draw charts to scale.**", "**Pick a chart by its job.**", "**Diagrams.**", "**Looks to stay away from.**", "**Design both themes.**", "the `canvas` tool's outline shows its top-level blocks and their size, remove_section drops one", "what they change is not kept"
  ]) {
    expect(skill).toContain(rule);
  }
  // "Don't rewrite it" read as "add a section": reports grew with every change.
  expect(skill).toContain("The page contract at the end of this skill says what the viewer does with a page");
  for (const absent of ["## Page contract", "`canvas_create`'s description", "read, not operated", "rejected proposals", "put next to index.html and referenced by relative path", "don't rewrite it", "the evidence follows"]) {
    expect(skill).not.toContain(absent);
  }
});

test("both prompts point report writing at the skill", () => {
  expect(manager).toContain("Load the `canvas-artifact` skill before writing a report");
  expect(worker).toContain("Load the `canvas-artifact` skill before writing a report");
  expect(worker).toContain("note of the step it belongs to");
  const workerTools = worker.slice(0, worker.indexOf("## Guidelines"));
  expect(workerTools).toMatch(/\bcanvas,/);
  expect(skill).toContain("a page that is one theme on purpose is excused");
});

test("none of the old one-look rules survive", () => {
  const sources = { contract: canvasPageContract(), skill, manager, worker };
  const hits = Object.entries(sources).flatMap(([name, text]) => OLD_RULES.filter((rule) => text.includes(rule)).map((rule) => `${name}: ${rule}`));
  expect(hits).toEqual([]);
  expect(fs.existsSync(path.join(root, "src/server/modules/skills/builtins/canvas-artifact/references"))).toBe(false);
});

test("the canvas tool's description points designs at the canvas-design skill", () => {
  for (const description of [canvasDescription(true), canvasDescription(false)]) {
    expect(description).toContain("Before a design, load the `canvas-design` skill.");
    expect(description).toContain('- create: give title, and kind "design" for a design.');
    expect(description).toContain("(for a design, its canvas.json index)");
    expect(description).not.toContain("the contract above");
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
    'Call `canvas` with `action: "create"` and `kind: "design"`', 'publish once (`canvas` with `action: "publish"`)', "`canvas.json`", "frames 80 px apart within a row and rows 120 px apart",
    "`is_interactive`", "`expand`", "`title1`", "phone 390×844", "FIXED size", "one look for every viewer", "`prefers-color-scheme`", "Tailwind `dark:`", "`light-dark()`",
    "**Do not check your work unless asked.**", "references/craft.md", "references/questions.md",
    "Every artboard page falls under the page contract at the end of this skill"
  ]) {
    expect(designSkill).toContain(rule);
  }
  expect(designSkill).not.toContain("`canvas_create`'s description");
  for (const kept of ["## Where the look comes from", "### From the product", "## Options", "## Drawing the screens", "**Accessible as drawn.**", "**Phone screens.**", "### Redrawing an interface that exists", "## Content rules"]) {
    expect(designCraft).toContain(kept);
  }
  expect(designQuestions).toContain("# Ask before you build");
});

// The six canvas_* tools are one `canvas` tool: no text an agent reads names the old ones.
test("no prompt, skill or the page contract names a retired canvas_* tool", () => {
  const sources = {
    contract: canvasPageContract(), skill, manager, worker,
    design: read("src/server/modules/skills/builtins/canvas-design/SKILL.md")
  };
  const hits = Object.entries(sources).flatMap(([name, text]) => [...text.matchAll(/\bcanvas_(create|publish|read|update|outline|remove_section)\b/g)].map((m) => `${name}: ${m[0]}`));
  expect(hits).toEqual([]);
});
