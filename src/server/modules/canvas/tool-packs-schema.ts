import { z } from "zod";

export const CANVAS_ACTIONS = ["create", "publish", "read", "outline", "remove_section"] as const;

/** One tool for every canvas action. A field another action takes is optional
 *  here and checked by the handler: a model fills a field it has no value for
 *  with "", which is no value. */
export const managerCanvasParams = z.object({
  action: z.enum(CANVAS_ACTIONS).describe("What to do: create, publish, read, outline or remove_section."),
  canvasId: z.string().optional().describe("The canvas, for every action but create."),
  title: z.string().max(120).optional().describe(
    "Create only: the canvas's name until publish takes it from the page's <title> (a report) or canvas.json's title (a design)."
  ),
  // "" is a model's filler for a field it has nothing for: no kind.
  kind: z.enum(["report", "design", ""]).optional().describe(
    'Create only: "report" (default), a page to read, or "design", artboards of UI screens at real sizes to compare and choose.'
  ),
  projectId: z.string().optional().describe("Create only: the project to store the canvas under. Omit for a global canvas."),
  index: z.number().int().optional().describe(
    "remove_section only: the block's position from outline. Positions shift as soon as anything is removed."
  ),
  expectLabel: z.string().optional().describe(
    "remove_section only: the label outline reported for that position. The removal is refused if it no longer matches."
  )
}).strict();

/** A worker's canvases go under its own project: it names none. */
export const workerCanvasParams = managerCanvasParams.omit({ projectId: true }).strict();

export type CanvasParams = z.infer<typeof managerCanvasParams>;
