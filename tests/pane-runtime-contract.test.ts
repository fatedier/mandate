import { expect, test } from "bun:test";
import type { PaneRuntime, Pane, ViewerHandle } from "../src/server/runtime/pane-runtime.js";

// Minimal fake impl — proves the interface compiles + exercises every method.
function makeFake(kind: "tmux"): PaneRuntime {
  const panes = new Map<string, Pane>();
  return {
    kind,
    async init() { return new Map(); },
    async dispose() {},
    async spawnPane(input) {
      const p: Pane = {
        id: "p-" + Math.random().toString(36).slice(2, 8),
        featureId: input.featureId,
        command: input.command ?? [],
        cwd: input.cwd,
        pid: 1234,
        status: "running",
        spawnedAt: new Date().toISOString()
      };
      panes.set(p.id, p);
      return p;
    },
    async killPane(id) { panes.delete(id); },
    async listPanes(featureId) {
      return [...panes.values()].filter((p) => p.featureId === featureId);
    },
    async getPane(id) { return panes.get(id) ?? null; },
    async sendKeys() {},
    async readScrollback() { return ""; },
    async attachViewer(): Promise<ViewerHandle> {
      return { detach() {}, resize() {}, handleMessage() {} };
    }
  };
}

test("PaneRuntime: contract methods exist + return correct shapes", async () => {
  const rt = makeFake("tmux");
  expect(rt.kind).toBe("tmux");
  const orphans = await rt.init();
  expect(orphans).toBeInstanceOf(Map);
  const p = await rt.spawnPane({ featureId: "f1", cwd: "/tmp" });
  expect(p.id).toMatch(/^p-/);
  expect(p.status).toBe("running");
  expect(await rt.listPanes("f1")).toHaveLength(1);
  expect(await rt.getPane(p.id)).toEqual(p);
  await rt.killPane(p.id);
  expect(await rt.listPanes("f1")).toHaveLength(0);
});
