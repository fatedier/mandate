import { expect, test } from "bun:test";
import { FeatureWindowStore } from "../src/server/modules/features/feature-window-store.js";
import { featureWindowKey } from "../src/server/modules/agent/tools/watch-window.js";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";

/**
 * Two producers build the same tmux window-watch key from independent code
 * paths: FeatureWindowStore.listActiveWindowKeys() reads it back out of SQL
 * columns; watch-window.ts's featureWindowKey() builds it from in-memory
 * ProjectRow/FeatureRow fields. A regression in either producer's template —
 * e.g. one of them growing a host segment back — must fail this test.
 *
 * Comparing each side to a hardcoded literal (the earlier version of this
 * test) only pins one producer at a time: if both regressed to the same
 * three-segment shape together, or if only the untested side regressed, the
 * literal-based tests would stay green. Deriving both sides from the same
 * seeded row and comparing them to each other is the only arrangement that
 * actually enforces "these two agree."
 */
test("FeatureWindowStore and watch-window.ts's featureWindowKey agree on the key shape", () => {
  const env = freshStoresEnv("md-window-key-");
  try {
    const projectId = seedProject(env.projects, { tmuxSessionName: "alpha" });
    const featureId = seedFeature(env.features, projectId, { tmuxWindowName: "login" });
    const project = env.projects.getById(projectId)!;
    const feature = env.features.getById(featureId)!;

    const store = new FeatureWindowStore(env.store.db);
    const storeKeys = [...store.listActiveWindowKeys()];

    expect(storeKeys).toEqual([featureWindowKey(project, feature)]);

    // The equality above would still hold if both producers regressed to the
    // same wrong shape together (e.g. both grew a host segment back). Pin the
    // shape itself so that failure mode is caught too.
    expect(storeKeys[0]!.split(":")).toHaveLength(2);
  } finally {
    env.cleanup();
  }
});
