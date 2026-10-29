import * as fs from "node:fs";
import contractPath from "./canvas-page-contract.md" with { type: "file" };

let cached: string | null = null;

/** What the viewer does with a report's page, and what it refuses. It is
 *  canvas_create's description, so every model sees it on every call. */
export function canvasPageContract(): string {
  cached ??= fs.readFileSync(contractPath, "utf8").trim();
  return cached;
}

/** Designs: one sentence in canvas_create's description; the
 *  format and the craft are in the canvas-design skill. */
const DESIGN_CANVAS_SENTENCE =
  "**Design canvases**: For UI proposals — screens at real sizes to compare and choose, before or after building — " +
  'pass kind "design" and load the `canvas-design` skill first. sourcePath is then the canvas\'s `canvas.json` index, ' +
  "and each artboard is a page beside it that follows the contract above, except that it is shown at its fixed size, " +
  "is one look for every viewer (it gets no theme: skip the contract's dark blocks and write no prefers-color-scheme rule; publish warns), " +
  "and needs no `<title>`: canvas.json's `title` names the canvas.";

export function canvasCreateDescription(featureScope: boolean): string {
  return [
    canvasPageContract(),
    DESIGN_CANVAS_SENTENCE,
    featureScope
      ? "This tool does not accept projectId; the feature's project is applied automatically. Put the report's id in the note of the plan step it belongs to, and the app links it from the plan."
      : "Optionally pass projectId to store the report under a project; omit projectId for a global report."
  ].join("\n\n");
}
