import { useEffect } from "react";
import { useAttentionCount } from "@/hooks/useAttentionCount";
import { badgeValue } from "@/lib/dock-badge";
import { isTauriRuntime } from "@/lib/runtime";

/** Desktop only: the sidebar's "needs you" count on the Dock icon, like
 *  Mail's unread count. Cleared (not "0") when nothing waits, so the badge
 *  disappears. Works while the window is hidden to the tray, which is when
 *  it matters. `set` is injectable for tests; the default talks to Tauri. */
export function DockBadge({ set = setTauriBadge }: { set?: (count: number | undefined) => Promise<void> | void }) {
  const count = useAttentionCount();
  const desktop = isTauriRuntime();
  useEffect(() => {
    if (!desktop) return;
    void Promise.resolve(set(badgeValue(count))).catch((error: unknown) => {
      console.warn("[mandate-desktop] setBadgeCount failed", error);
    });
  }, [count, desktop, set]);
  return null;
}

async function setTauriBadge(count: number | undefined): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setBadgeCount(count);
}
