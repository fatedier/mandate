import type { MandateModule } from "../module.js";
import { scopePack } from "../../runtime/scope-packs.js";
import { initializePersonalAgentSchema } from "./schema.js";
import { buildPersonalScope } from "./personal-scope.js";
import { mountPersonalAgentRoutes } from "./personal-http.js";
import { ThreadTabStore, mountThreadTabRoutes } from "./thread-tabs.js";

export const personalModule: MandateModule = {
  id: "personal",
  schema: [initializePersonalAgentSchema],
  scopePacks: (ctx) => [scopePack("personal", () => buildPersonalScope(ctx.personal))],
  mountRoutes: (app, { deps }) => {
    if (deps.personalAgent) mountPersonalAgentRoutes(app, { personalAgent: deps.personalAgent });
    mountThreadTabRoutes(app, { store: new ThreadTabStore(deps.store.db), agentStore: deps.agentStore, sse: deps.sse });
  }
};
