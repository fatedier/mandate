import { isTauriRuntime } from "@/lib/runtime";

const INTERACTIVE = 'button, a, input, textarea, select, summary, [role="button"], [role="tab"], [role="menuitem"], [role="separator"], [contenteditable]';

/** Tauri's built-in drag handler only fires when the mousedown target itself
 *  carries `data-tauri-drag-region`; any child (a title, a slot div) blocks it.
 *  This delegate makes the whole band drag: it walks up to the nearest region,
 *  skips interactive descendants, and leaves targets that carry the attribute
 *  to the built-in handler (which also owns double-click maximize). */
export function installTauriDragRegion(
  doc: Document,
  startDragging: () => Promise<void> | void
): () => void {
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.detail > 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.hasAttribute("data-tauri-drag-region")) return;
    if (target.closest(INTERACTIVE)) return;
    if (!target.closest("[data-tauri-drag-region]")) return;
    event.preventDefault();
    void startDragging();
  };
  doc.addEventListener("mousedown", onMouseDown);
  return () => doc.removeEventListener("mousedown", onMouseDown);
}

/** Boot-time wiring: no-op in the browser. */
export function installTauriDragRegionIfDesktop(doc: Document = document): void {
  if (!isTauriRuntime()) return;
  installTauriDragRegion(doc, async () => {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().startDragging();
  });
}
