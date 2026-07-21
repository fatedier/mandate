import type { MandateModule } from "../module.js";
import { mountSkillRoutes } from "./skill-routes.js";
import { buildSkillToolPacks } from "./tool-packs.js";

export const skillsModule: MandateModule = {
  id: "skills",
  mountRoutes: (app, { deps }) => mountSkillRoutes(app, deps),
  commonToolPacks: (ctx) => buildSkillToolPacks({
    scope: ctx.scope,
    skillRegistry: ctx.skillRegistry
  })
};
