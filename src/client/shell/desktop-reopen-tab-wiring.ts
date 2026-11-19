import { isTauriRuntime } from "@/lib/runtime";
import { reopenClosedTab } from "@/lib/reopen-closed-tab";

type Listen = (event: string, handler: () => void) => Promise<unknown>;

const tauriListen: Listen = (event, handler) => import("@tauri-apps/api/event").then(({ listen }) => listen(event, handler));

/** Boot-time wiring for the desktop app's File › Reopen Closed Tab (⌘⇧T,
 *  `mandate:reopen-closed-tab` events): the right panel in sight reopens its
 *  latest closed tab. No-op in the browser, which keeps the key for its own
 *  tabs. */
export function installDesktopReopenTabIfDesktop(listen: Listen = tauriListen): void {
  if (!isTauriRuntime()) return;
  void listen("mandate:reopen-closed-tab", () => reopenClosedTab()).catch((error: unknown) => {
    console.warn("[mandate-desktop] reopen tab menu events unavailable", error);
  });
}
