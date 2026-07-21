import fs from "node:fs";
import { AgentStore } from "../modules/agent/agent-store.js";
import { CanvasStore } from "../modules/canvas/canvas-store.js";
import { FeaturesStore } from "../modules/features/features-store.js";
import { PaneMetadataStore } from "../modules/panes/pane-metadata-store.js";
import { ProjectsStore } from "../modules/projects/projects-store.js";
import { WorkItemStore } from "../modules/agent/work-item-store.js";
import { WorkItemChangeEmitter } from "../modules/agent/work-item-events.js";
import { resolveDataDir } from "../platform/fs/data-dir.js";
import { managerResourcesDir, migrateOverviewResourcesDir } from "../platform/fs/resources.js";
import { MandateStore } from "./store.js";

interface AppStores {
  dbDir: string;
  store: MandateStore;
  projectsStore: ProjectsStore;
  featuresStore: FeaturesStore;
  agentStore: AgentStore;
  canvasStore: CanvasStore;
  workStore: WorkItemStore;
  paneMetadataStore: PaneMetadataStore;
}

export function createAppStores(): AppStores {
  // mandate.db lives in the data dir (~/.mandate by default), alongside
  // worktrees and memories. Override with MANDATE_DB_DIR for smoke tests and
  // local isolation.
  const dbDir = process.env.MANDATE_DB_DIR || resolveDataDir();
  fs.mkdirSync(dbDir, { recursive: true });
  // Manager agent's working directory: bash/write/edit tools scope writes here.
  // Move the pre-rename "overview" bucket into place before anything touches it.
  migrateOverviewResourcesDir(dbDir);
  fs.mkdirSync(managerResourcesDir(dbDir), { recursive: true });

  const store = new MandateStore(dbDir);
  const workItemChanges = new WorkItemChangeEmitter();
  return {
    dbDir,
    store,
    projectsStore: new ProjectsStore(store.db),
    featuresStore: new FeaturesStore(store.db, workItemChanges),
    agentStore: new AgentStore(store.db),
    canvasStore: new CanvasStore(store.db, dbDir),
    workStore: new WorkItemStore(store.db, workItemChanges),
    paneMetadataStore: new PaneMetadataStore(store.db)
  };
}
