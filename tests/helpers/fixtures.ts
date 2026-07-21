import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MandateStore } from "../../src/server/app/store.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import { startFakeTmuxServer, type FakeTmuxServer } from "./fake-tmux.js";

// Common test fixtures. Each `freshXxxEnv()` returns the constructed stores
// plus a `cleanup()` to call from the test's finally block. Each `seedXxx()`
// inserts a row with sensible defaults that can be overridden field-by-field.

export interface AgentEnv {
  dir: string;
  store: MandateStore;
  agentStore: AgentStore;
  cleanup: () => void;
}

/** Fresh tmp data dir + MandateStore + AgentStore. Cleanup removes the dir. */
export function freshAgentEnv(prefix = "md-agent-"): AgentEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new MandateStore(dir);
  return {
    dir,
    store,
    agentStore: new AgentStore(store.db),
    cleanup: () => {
      // The connection first: rmSync would otherwise unlink the database out
      // from under an open handle, and every env that ran before this one would
      // still be holding one. A file with dozens of tests leaks a connection per
      // test that way.
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export interface StoresEnv {
  dir: string;
  store: MandateStore;
  projects: ProjectsStore;
  features: FeaturesStore;
  agentStore: AgentStore;
  cleanup: () => void;
}

/** Fresh tmp data dir + all four stores. No tmux server (use this for unit
 *  tests that exercise tools / store logic without touching tmux). */
export function freshStoresEnv(prefix = "md-stores-"): StoresEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const store = new MandateStore(dir);
  return {
    dir,
    store,
    projects: new ProjectsStore(store.db),
    features: new FeaturesStore(store.db),
    agentStore: new AgentStore(store.db),
    cleanup: () => {
      // The connection first: rmSync would otherwise unlink the database out
      // from under an open handle, and every env that ran before this one would
      // still be holding one. A file with dozens of tests leaks a connection per
      // test that way.
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export interface ProjectEnv extends StoresEnv {
  tmux: FakeTmuxServer;
}

/** Fresh tmp data dir + all four stores + an in-memory tmux.
 *
 *  The fake is the default because almost nothing that opens a session is
 *  asking a question about tmux, and a test that isn't should not need the
 *  binary installed to run. Reach for freshRealTmuxProjectEnv only when the
 *  behaviour under test is tmux's own — and put that test under e2e/. */
export function freshProjectEnv(prefix = "md-proj-"): ProjectEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tmux = startFakeTmuxServer();
  const store = new MandateStore(dir);
  return {
    dir,
    store,
    projects: new ProjectsStore(store.db),
    features: new FeaturesStore(store.db),
    agentStore: new AgentStore(store.db),
    tmux,
    cleanup: () => {
      tmux.cleanup();
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Insert a project row with sensible test defaults. Override any field
 *  by passing a partial. Returns the inserted id. */
export function seedProject(
  projects: ProjectsStore,
  overrides: Partial<Parameters<ProjectsStore["insert"]>[0]> = {}
): string {
  return projects.insert({
    name: "P",
    workingDir: "/tmp",
    isGit: false,
    gitRemote: null,
    tmuxSessionName: "md-p",
    ownership: "app",
    ...overrides
  });
}

/** Insert a feature row with sensible test defaults. Override any field
 *  by passing a partial. Returns the inserted id. */
export function seedFeature(
  features: FeaturesStore,
  projectId: string,
  overrides: Partial<Parameters<FeaturesStore["insert"]>[0]> = {}
): string {
  return features.insert({
    projectId,
    name: "F",
    mode: "shared-cwd",
    branch: null,
    worktreePath: null,
    tmuxWindowName: "f",
    ownership: "app",
    ...overrides
  });
}

/** Wake-scheduler stub that records nothing. Use this when a test
 *  wires an agents-api app but doesn't care about wake side effects. */
export const NOOP_WAKE = { wake: () => "wake-noop" };

/** Set MANDATE_DATA_DIR to a fresh temp dir for the duration of a test
 *  that exercises code paths reading `resolveDataDir()`. Returns the dir
 *  + a `restore()` to call in finally. */
export function withTempDataDir(): { dataDir: string; restore: () => void } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "md-data-"));
  const old = process.env.MANDATE_DATA_DIR;
  process.env.MANDATE_DATA_DIR = dataDir;
  return {
    dataDir,
    restore: () => {
      if (old === undefined) delete process.env.MANDATE_DATA_DIR;
      else process.env.MANDATE_DATA_DIR = old;
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
    }
  };
}
