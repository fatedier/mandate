export interface CanvasReference {
  canvasId: string;
  title: string;
  path: string;
}

export function isCanvasReferenceTool(toolName: string): boolean {
  return toolName === "canvas_publish";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
