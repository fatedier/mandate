import { mountSseRoutes } from "./sse-routes.js";
import type { MandateModule } from "../module.js";

export const sseModule: MandateModule = {
  id: "sse",
  mountRoutes: (app, { deps }) => mountSseRoutes(app, deps)
};
