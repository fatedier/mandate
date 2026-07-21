import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { MandateStore } from "../../src/server/app/store.js";
import { ProjectsStore } from "../../src/server/modules/projects/projects-store.js";
import { FeaturesStore } from "../../src/server/modules/features/features-store.js";
import { AgentStore } from "../../src/server/modules/agent/agent-store.js";
import type { StoresEnv } from "../../tests/helpers/fixtures.js";
import { startTestTmuxServer } from "./tmux-server.js";

// Fixtures that reach for a real binary, and therefore only work here.
// tests/helpers holds the rest, which both tiers share — the dependency runs
// e2e -> tests and never the other way, so nothing impure can drift into the
// pure tier by being imported from it.

export interface RealTmuxProjectEnv extends StoresEnv {
  tmux: ReturnType<typeof startTestTmuxServer>;
}

/** Fresh tmp data dir + all four stores + a real tmux server on its own
 *  socket. Needs the tmux binary. The unit tier's freshProjectEnv answers the
 *  same calls from memory; use this one only when the behaviour under test is
 *  tmux's own. */
export function freshRealTmuxProjectEnv(prefix = "md-proj-"): RealTmuxProjectEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const tmux = startTestTmuxServer();
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

export interface TempGitRepo {
  dir: string;
  cleanup: () => void;
}

/** A temporary git repo with one initial commit on `main` and a `README` file.
 *  Sets its identity locally rather than relying on a global gitconfig, so it
 *  works in a container with no HOME to speak of. */
export function tempGitRepo(): TempGitRepo {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-repo-"));
  spawnSync("git", ["-C", dir, "init", "-b", "main"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.email", "t@t"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.name", "T"], { encoding: "utf8" });
  fs.writeFileSync(path.join(dir, "README"), "x");
  spawnSync("git", ["-C", dir, "add", "."], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "-m", "init"], { encoding: "utf8" });
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
