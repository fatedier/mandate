import * as fs from "node:fs";
import contractPath from "./canvas-page-contract.md" with { type: "file" };

let cached: string | null = null;

/** What the viewer does with a canvas page, and what it refuses. It ends
 *  the canvas-artifact and canvas-design skills as an agent loads them. */
export function canvasPageContract(): string {
  cached ??= fs.readFileSync(contractPath, "utf8").trim();
  return cached;
}

/** The canvas tool's description: an opening, then one line per
 *  action. A worker's create names the plan step; another agent's, a project. */
export function canvasDescription(workerScope: boolean): string {
  return [
    "Create, publish, read and trim canvases. A report is a designed HTML page the user opens full screen, for depth a chat reply or a plan note cannot hold; a design holds UI screens at real sizes to compare and choose, before or after building. You write the page into the canvas's sourcePath with the file tools; this tool never takes content. Before writing a report, load the `canvas-artifact` skill: it holds the page contract (what the viewer does with the page, and what it will not do) and the design guidance. Before a design, load the `canvas-design` skill.",
    workerScope
      ? "- create: give title, and kind \"design\" for a design. The worker's project is applied automatically. Returns canvasId, title, path and sourcePath (for a design, its canvas.json index). Write the page there, then publish. Put the canvas's id in the note of the plan step it belongs to, and the app links it from the plan."
      : "- create: give title, and kind \"design\" for a design. Give projectId to store it under a project; omit it for a global canvas. Returns canvasId, title, path and sourcePath (for a design, its canvas.json index). Write the page there, then publish.",
    "- publish: give canvasId, after writing or editing the source. It renders what the user sees from index.html (a design: canvas.json and every artboard it lists). It returns warnings for problems it can see in the page (a report's missing <title>, a blocked host, no body background, a report's token defined only in dark); fix them and publish again. A page over 16 MB is refused, and so is a design with a missing file or an index it cannot read.",
    "- read: give canvasId. Returns its title, kind, size and sourcePath, not the HTML; read sourcePath with the file tools for that.",
    "- outline: give canvasId. Lists a report's top-level blocks with their labels and visible character counts, without reading the whole file. Use it before remove_section, and to see which part of a long report carries the bulk.",
    "- remove_section: give canvasId, and index and expectLabel from outline. Removes that one top-level block from the source; refused if the block has moved. Publish once afterwards, for any number of removals.",
    "The thread that created a canvas can change it; a worker's own thread can change that worker's canvases; a manager can change any canvas."
  ].join("\n");
}
