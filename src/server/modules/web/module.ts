import type { MandateModule } from "../module.js";
import { toolPack } from "../../runtime/tool-packs.js";
import { mountWebRoutes } from "./web-routes.js";

/** Web search and page reading for every agent. Your agent reuses the
 *  manager's tools by name, a subagent its parent's. */
export const webModule: MandateModule = {
  id: "web",
  mountRoutes: (app, { deps }) => mountWebRoutes(app, deps),
  commonToolPacks: (ctx) => (ctx.web ? [toolPack("web.core", [ctx.scope], ctx.web.tools)] : [])
};
