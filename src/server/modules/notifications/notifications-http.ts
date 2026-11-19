import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api-contracts.js";
import type { PresenceReport } from "../../../shared/api/notifications.js";
import { errorText } from "../../../shared/error-text.js";
import type { NotificationService } from "./notification-service.js";

export function mountNotificationRoutes(app: Hono, deps: { notifications: NotificationService }): void {
  const service = deps.notifications;
  // A closing window sends this with sendBeacon: read whatever its type says.
  app.post(API_ROUTES.notificationsPresence, async (c) => {
    const report = parsePresence(await c.req.json().catch(() => null));
    if (!report) return c.json({ error: "invalid presence report" }, 400);
    service.reportPresence(report);
    return c.json({ ok: true });
  });
  app.post(API_ROUTES.notificationsTest, async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(await service.test(body));
    } catch (err) {
      return c.json({ error: errorText(err) }, 400);
    }
  });
  app.post(API_ROUTES.notificationsTelegramConnect, async (c) => {
    const body = await c.req.json().catch(() => null);
    return c.json(await service.connectTelegram(body));
  });
}

function parsePresence(value: unknown): PresenceReport | null {
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (typeof r.windowId !== "string" || !r.windowId || r.windowId.length > 100) return null;
  if (r.gone === true) {
    return { windowId: r.windowId, device: "desktop", shell: "browser", visible: false, focused: false, lastInputAt: null, path: "", canShowSystem: false, gone: true };
  }
  if (r.device !== "desktop" && r.device !== "phone") return null;
  if (r.shell !== "browser" && r.shell !== "desktop-app") return null;
  if (typeof r.visible !== "boolean" || typeof r.focused !== "boolean" || typeof r.canShowSystem !== "boolean") return null;
  if (r.lastInputAt !== null && typeof r.lastInputAt !== "string") return null;
  if (typeof r.path !== "string" || r.path.length > 2000) return null;
  return {
    windowId: r.windowId, device: r.device, shell: r.shell, visible: r.visible, focused: r.focused,
    lastInputAt: r.lastInputAt, path: r.path, canShowSystem: r.canShowSystem,
    ...(typeof r.threadChat === "string" && r.threadChat && r.threadChat.length <= 100 ? { threadChat: r.threadChat } : {})
  };
}
