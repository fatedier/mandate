import type { MandateModule } from "../module.js";
import { scopePack } from "../../runtime/scope-packs.js";
import { initializeGlobalAgentSchema } from "./schema.js";
import { buildGlobalScope } from "./global-scope.js";
import { mountGlobalAgentRoutes } from "./global-http.js";

export const globalModule: MandateModule = {
  id: "global",
  schema: [initializeGlobalAgentSchema],
  scopePacks: (ctx) => [scopePack("global", () => buildGlobalScope(ctx.global))],
  mountRoutes: (app, { deps }) => {
    if (deps.globalAgent) mountGlobalAgentRoutes(app, { globalAgent: deps.globalAgent });
  }
};
