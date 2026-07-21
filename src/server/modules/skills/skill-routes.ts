import type { Hono } from "hono";
import { API_ROUTES, type SkillsResponse } from "../../../shared/api-contracts.js";
import type { AppDeps } from "../../app/deps.js";

export function mountSkillRoutes(app: Hono, deps: Pick<AppDeps, "skills">): void {
  app.get(API_ROUTES.skills, (c) => {
    const response = { skills: deps.skills.list() } satisfies SkillsResponse;
    return c.json(response);
  });
  app.post(API_ROUTES.skillsRefresh, async (c) => {
    await deps.skills.refresh();
    const response = { skills: deps.skills.list() } satisfies SkillsResponse;
    return c.json(response);
  });
}
