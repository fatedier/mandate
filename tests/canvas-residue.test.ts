import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { sourceFiles } from "./helpers/source-files.js";

/** Strings that belonged to removed canvas machinery. */
const FORBIDDEN = [
  "canvas_events",
  "canvasEvents",
  "CanvasEventRequest",
  "mandate.canvas.submit",
  "data-mandate-action",
  "data-mandate-submit",
  "submitCanvasEvent",
  "anti-ai-slop",
  "tailwind-3.4.17",
  "canvas-tailwind",
  "data-mandate-theme",
  "mandate-canvas-base",
  "computeCanvasFit",
  "reduceFrameReadiness",
  "mandate.canvas.height",
  // The hand-written HTML and CSS scanners, replaced by the browser, parse5
  // and postcss.
  "htmlTags",
  "tagAttributes",
  "decodeEntities",
  "injectAfterHeadOpen",
  "setHtmlTheme",
  // The scanner's function; the CSSOM's sheet.cssRules property is the browser's.
  "cssRules(",
  "cssCode",
  "splitTopLevel",
  "declaredViewportWidth",
  // The artboard prefers-color-scheme swap script, dropped for the
  // convention of explicit colours (publish warns).
  "artboardSchemeScript",
  "data-mandate-scheme",
  // The desktop link handoff through the page, replaced by the desktop
  // shell's own new-window handler.
  "mandate.canvas.open",
  "openLinksViaParent"
];

test("no source file still mentions removed canvas machinery", () => {
  const hits: string[] = [];
  for (const file of sourceFiles(path.join(process.cwd(), "src"), /\.(ts|tsx|md|css|js)$/)) {
    const text = fs.readFileSync(file, "utf8");
    for (const needle of FORBIDDEN) {
      if (text.includes(needle)) hits.push(`${path.relative(process.cwd(), file)}: ${needle}`);
    }
  }
  expect(hits).toStrictEqual([]);
});
