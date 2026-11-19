import { create } from "zustand";

/** The manager thread whose chat this window has in sight now, null for
 *  none: what the window's presence report names, so what that thread says
 *  is not told to the personal agent while the user reads it there. */
export const useThreadChatInSight = create<{ threadId: string | null }>()(() => ({ threadId: null }));

/** Whether a thread page has its own chat on screen. A wide window: beside
 *  the panel, or alone, not behind a maximized panel; a narrow row shows one
 *  side, the chat's or the panel's in its place. A phone: only with the
 *  worker sheet closed (at half height it covers the chat's end). */
export function threadChatInSight(view: {
  phone: boolean;
  panelOpen: boolean;
  maximized: "panel" | null;
  narrow: boolean;
  narrowView: "chat" | "panel";
  sheet: "closed" | "half" | "full";
}): boolean {
  if (view.phone) return view.sheet === "closed";
  if (!view.panelOpen) return true;
  if (view.narrow) return view.narrowView !== "panel";
  return view.maximized !== "panel";
}
