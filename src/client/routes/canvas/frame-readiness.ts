/** Readiness of an auto-sizing canvas iframe. The bridge script inside the
 *  frame posts its body height once the document has laid out; until then the
 *  frame is an empty box, which is what the Overview used to show as a black
 *  rectangle. A frame that never reports is a failure the user can retry. */
export type FrameReadiness = "loading" | "ready" | "failed";

export type FrameEvent =
  | { type: "height" }
  | { type: "timeout" }
  | { type: "reset" };

export const FRAME_LOAD_TIMEOUT_MS = 8000;

export function reduceFrameReadiness(state: FrameReadiness, event: FrameEvent): FrameReadiness {
  switch (event.type) {
    case "height":
      return "ready";
    case "timeout":
      return state === "loading" ? "failed" : state;
    case "reset":
      return "loading";
  }
}
