import type { Hono } from "hono";
import { API_ROUTES } from "../../../shared/api/routes.js";
import type { AppDeps } from "../../app/deps.js";
import { checkWebSearch, createWebSearch } from "./web-search.js";

/** The Settings check: one real search with the saved settings. It never
 *  runs by itself; each check spends a search. */
export function mountWebRoutes(app: Hono, deps: Pick<AppDeps, "config" | "store">, opts: { now?: () => number } = {}): void {
  app.post(API_ROUTES.settingsWebSearchCheck, async (c) => {
    const result = await checkWebSearch(createWebSearch({
      getConfig: () => deps.config,
      store: deps.store,
      ...(opts.now ? { now: opts.now } : {})
    }));
    return c.json({ ok: true, ...result });
  });
}
