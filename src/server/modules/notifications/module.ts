import type { MandateModule } from "../module.js";
import { initializeNotificationsSchema } from "./schema.js";
import { mountNotificationRoutes } from "./notifications-http.js";

export const notificationsModule: MandateModule = {
  id: "notifications",
  schema: [initializeNotificationsSchema],
  mountRoutes: (app, { deps }) => {
    if (deps.notifications) mountNotificationRoutes(app, { notifications: deps.notifications });
  }
};
