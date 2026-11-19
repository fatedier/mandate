/** Native notifications in the desktop app, through its notification
 *  plugin. A click reaches the app only for notifications shown while its
 *  listener exists, so the listener is set up before the first one. */
export interface DesktopNotifier {
  /** The plugin answers and has the permission. */
  ready(): Promise<boolean>;
  show(notice: { title: string; body: string; link: string }): Promise<void>;
  /** Calls `open` with a clicked notification's link, once set up. */
  listen(open: (link: string) => void): Promise<void>;
}

/** The link of a clicked notification: from this page's own record, or from
 *  the notification itself when the page was loaded again since it showed. */
export function clickedLink(event: { notification: { id?: number; extra?: Record<string, unknown> } | null }, links: ReadonlyMap<number, string>): string | null {
  const notice = event.notification;
  if (!notice) return null;
  const known = notice.id === undefined ? undefined : links.get(notice.id);
  if (known) return known;
  const carried = notice.extra?.link;
  return typeof carried === "string" ? carried : null;
}

/** Ids the plugin takes are 32-bit integers. */
let nextId = 1 + Math.floor(Math.random() * 1_000_000);
const links = new Map<number, string>();
let listening: Promise<void> | null = null;

async function bringToFront(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  await window.show();
  await window.unminimize();
  await window.setFocus();
}

export const tauriDesktopNotifier: DesktopNotifier = {
  async ready() {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return await isPermissionGranted();
    } catch {
      return false;
    }
  },
  async show(notice) {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    const id = nextId;
    nextId = nextId >= 2_000_000_000 ? 1 : nextId + 1;
    links.set(id, notice.link);
    sendNotification({ id, title: notice.title, body: notice.body, extra: { link: notice.link } });
  },
  listen(open) {
    listening ??= import("@tauri-apps/plugin-notification")
      .then(({ onAction }) => onAction((event) => {
        const link = clickedLink(event, links);
        void bringToFront().catch((error: unknown) => console.warn("[mandate-desktop] could not bring the window forward", error));
        if (link) open(link);
      }))
      .then(() => undefined)
      .catch((error: unknown) => console.warn("[mandate-desktop] notification clicks are not available", error));
    return listening;
  }
};
