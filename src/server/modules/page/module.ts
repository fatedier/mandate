import type { MandateModule } from "../module.js";
import { initializeAgentPageSchema } from "./schema.js";
import { mountPageRoutes } from "./page-routes.js";

export const pageModule: MandateModule = {
  id: "page",
  schema: [initializeAgentPageSchema],
  mountRoutes: (app, { deps }) => {
    if (deps.pageStore) {
      mountPageRoutes(app, {
        pageStore: deps.pageStore,
        ...(deps.pageSources ? { sources: deps.pageSources } : {}),
        ...(deps.pageBuiltins ? { builtins: deps.pageBuiltins } : {}),
        ...(deps.pageAnswers ? { answers: deps.pageAnswers } : {})
      });
    }
  }
};
