import { expect, test } from "bun:test";
import { buildCreateProjectTool } from "../src/server/modules/projects/tools/create-project.js";
import { freshProjectEnv } from "./helpers/fixtures.js";

test("create_project: creates a tmux-backed project", async () => {
  const env = freshProjectEnv("md-cp-rt-");
  try {
    const tool = buildCreateProjectTool({
      projectsStore: env.projects, featuresStore: env.features,
      tmuxClient: env.tmux.client, broadcast: () => {}
    });
    const r = await tool.handler(
      { name: "p1", workingDir: env.dir },
      { threadId: "t1", wakeId: "w1" }
    );
    expect(r.projectId).toBeTruthy();
    expect(env.projects.getById(r.projectId!)!.tmuxSessionName).toBeTruthy();
  } finally { env.cleanup(); }
});
