import { buildArchiveProjectTool } from "./tools/archive-project.js";
import { buildCreateProjectTool } from "./tools/create-project.js";
import { buildListProjectsTool } from "./tools/list-projects.js";
import type { LifecyclePublisher } from "../../runtime/events.js";
import type { WorkersStore } from "../workers/workers-store.js";
import type { ProjectsStore } from "./projects-store.js";
import { toolPack, type ToolPack } from "../../runtime/tool-packs.js";
import type { TmuxClient } from "../../platform/tmux/tmux.js";
import type { GitClient } from "../../platform/git/git.js";

export function buildProjectToolPacks(input: {
  projectsStore: ProjectsStore;
  workersStore: WorkersStore;
  tmuxClient: TmuxClient;
  gitClient: GitClient;
  sessionDataDir?: string;
  publishLifecycle: LifecyclePublisher;
}): ToolPack[] {
  return [
    toolPack("projects.catalog", ["manager"], [
      buildListProjectsTool({
        projectsStore: input.projectsStore,
        workersStore: input.workersStore
      })
    ]),
    toolPack("projects.lifecycle", ["manager"], [
      buildCreateProjectTool({
        projectsStore: input.projectsStore,
        workersStore: input.workersStore,
        tmuxClient: input.tmuxClient,
        gitClient: input.gitClient,
        sessionDataDir: input.sessionDataDir,
        broadcast: input.publishLifecycle
      }),
      buildArchiveProjectTool({
        projectsStore: input.projectsStore,
        workersStore: input.workersStore,
        tmuxClient: input.tmuxClient,
        sessionDataDir: input.sessionDataDir,
        broadcast: input.publishLifecycle
      })
    ])
  ];
}
