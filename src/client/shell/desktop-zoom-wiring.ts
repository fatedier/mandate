import { createZoomController, zoomShortcut, type ZoomDirection } from "@/lib/desktop-zoom";
import { isTauriRuntime } from "@/lib/runtime";
import { useUIStore } from "@/store/ui";

/** Boot-time wiring for the desktop shell's interface zoom: applies the
 *  remembered factor, keeps the webview in step with the store, and feeds the
 *  controller from the native View menu (`mandate:zoom` events, which also
 *  carry the ⌘= / ⌘− / ⌘0 accelerators) and from keydown (for ⌘+, whose Shift
 *  the menu accelerator does not match, and as the fallback if the menu ever
 *  lets a key through — the controller dedupes the two). No-op in the browser. */
export function installDesktopZoomIfDesktop(doc: Document = document): void {
  if (!isTauriRuntime()) return;
  const controller = createZoomController({
    get: () => useUIStore.getState().interfaceZoom,
    set: (factor) => useUIStore.getState().setInterfaceZoom(factor)
  });

  doc.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    const direction = zoomShortcut(event);
    if (!direction) return;
    event.preventDefault();
    controller.step(direction, "keyboard");
  }, true);

  void import("@tauri-apps/api/event").then(({ listen }) =>
    listen<ZoomDirection>("mandate:zoom", (event) => controller.step(event.payload, "menu"))
  ).catch((error: unknown) => {
    console.warn("[mandate-desktop] zoom menu events unavailable", error);
  });

  void import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => {
    const webview = getCurrentWebview();
    const apply = (factor: number) => {
      void webview.setZoom(factor).catch((error: unknown) => {
        console.warn("[mandate-desktop] setZoom failed", error);
      });
    };
    apply(useUIStore.getState().interfaceZoom);
    let previous = useUIStore.getState().interfaceZoom;
    useUIStore.subscribe((state) => {
      if (state.interfaceZoom === previous) return;
      previous = state.interfaceZoom;
      apply(state.interfaceZoom);
    });
  }).catch((error: unknown) => {
    console.warn("[mandate-desktop] webview zoom unavailable", error);
  });
}
