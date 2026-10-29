import { mountSessionsRoutes } from "./session-routes.js";
import type { MandateModule } from "../module.js";

export const sessionsModule: MandateModule = {
  id: "sessions",
  mountRoutes: (app, { deps }) => mountSessionsRoutes(app, {
    projects: deps.projects,
    tmuxClient: deps.tmuxClient,
    getRawState: () => deps.poller.getRaw()
  })
};
