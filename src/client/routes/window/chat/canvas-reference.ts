import { isRecord } from "../../../../shared/guards";
export interface CanvasReference {
  canvasId: string;
  title: string;
  path: string;
}

/** A call whose result is a canvas to open: a publish, by the canvas tool or
 *  by the canvas_publish it replaced (still in older transcripts). */
export function isCanvasReferenceCall(call: { toolName: string; args?: unknown }): boolean {
  if (call.toolName === "canvas_publish") return true;
  return call.toolName === "canvas" && isRecord(call.args) && call.args.action === "publish";
}

export function canvasReferenceFromResult(value: unknown): CanvasReference | null {
  if (!isRecord(value)) return null;
  const { ok, canvasId, title, path } = value;
  if (
    ok !== true ||
    typeof canvasId !== "string" ||
    typeof title !== "string" ||
    typeof path !== "string" ||
    !path.startsWith("/canvas/")
  ) {
    return null;
  }
  return {
    canvasId,
    title: title.trim() || "Untitled canvas",
    path
  };
}
