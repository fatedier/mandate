import { expect, test } from "bun:test";
import { SkillRegistry } from "../src/server/modules/skills/skill-registry.js";
import type { SkillEntry } from "../src/server/modules/skills/skill-loader.js";

function entry(over: Partial<SkillEntry>): SkillEntry {
  return {
    name: "x",
    description: "desc",
    scope: ["manager", "worker"],
    sourcePath: "/fake/SKILL.md",
    loadBody: async () => "body",
    resolveReference: () => null,
    ...over
  };
}

test("SkillRegistry: empty sources → empty manifest", () => {
  const r = new SkillRegistry([]);
  expect(r.getByScope("manager")).toEqual([]);
  expect(r.renderManifest("manager")).toBe("");
});

test("SkillRegistry: single skill visible to its scope only", () => {
  const r = new SkillRegistry([
    [entry({ name: "ov", scope: ["manager"] })]
  ]);
  expect(r.getByScope("manager").length).toBe(1);
  expect(r.getByScope("worker").length).toBe(0);
});

test("SkillRegistry: default scope (both) visible to both agents", () => {
  const r = new SkillRegistry([
    [entry({ name: "both" })]   // entry helper defaults scope to both
  ]);
  expect(r.getByScope("manager").length).toBe(1);
  expect(r.getByScope("worker").length).toBe(1);
});

test("SkillRegistry: later source overrides earlier on name conflict", () => {
  const builtin = entry({ name: "ui-routes", description: "builtin", sourcePath: "/builtin/ui-routes/SKILL.md" });
  const user = entry({ name: "ui-routes", description: "user override", sourcePath: "/home/.mandate/skills/ui-routes/SKILL.md" });
  const r = new SkillRegistry([[builtin], [user]]);
  const list = r.getByScope("manager");
  expect(list.length).toBe(1);
  expect(list[0]!.description).toBe("user override");
  expect(list[0]!.sourcePath).toBe("/home/.mandate/skills/ui-routes/SKILL.md");
});

test("SkillRegistry: loadBody returns null for unknown name", async () => {
  const r = new SkillRegistry([[entry({ name: "known" })]]);
  expect(await r.loadBody("unknown", "manager")).toBe(null);
});

test("SkillRegistry: loadBody returns null when scope mismatches", async () => {
  const r = new SkillRegistry([[entry({ name: "ov", scope: ["manager"] })]]);
  expect(await r.loadBody("ov", "worker")).toBe(null);
});

test("SkillRegistry: loadBody returns the body when name + scope match", async () => {
  const r = new SkillRegistry([[
    entry({ name: "ov", scope: ["manager"], loadBody: async () => "hello" })
  ]]);
  expect(await r.loadBody("ov", "manager")).toBe("hello");
});

test("SkillRegistry: renderManifest contains one bullet per visible skill", () => {
  const r = new SkillRegistry([[
    entry({ name: "a", description: "first", scope: ["manager"] }),
    entry({ name: "b", description: "second", scope: ["manager", "worker"] })
  ]]);
  const manifest = r.renderManifest("manager");
  expect(manifest).toMatch(/<available-skills>/);
  expect(manifest).toMatch(/- a: first/);
  expect(manifest).toMatch(/- b: second/);
  expect(manifest).toMatch(/<\/available-skills>/);
});

test("SkillRegistry: renderManifest empty string when no skills in scope", () => {
  const r = new SkillRegistry([[entry({ name: "x", scope: ["worker"] })]]);
  expect(r.renderManifest("manager")).toBe("");
});

test("SkillRegistry: refresh re-invokes loaders and rebuilds the map", async () => {
  let callCount = 0;
  const r = new SkillRegistry();
  r.setLoaders([
    async () => {
      callCount++;
      return [entry({ name: callCount === 1 ? "first" : "second" })];
    }
  ]);
  await r.refresh();
  expect(r.getByScope("manager").length).toBe(1);
  expect(r.getByScope("manager")[0]!.name).toBe("first");
  await r.refresh();
  expect(r.getByScope("manager").length).toBe(1);
  expect(r.getByScope("manager")[0]!.name).toBe("second");
  expect(callCount).toBe(2);
});

test("SkillRegistry: maybeRefresh skips when within throttle window, fires past it", async () => {
  let callCount = 0;
  const r = new SkillRegistry();
  r.setLoaders([
    async () => { callCount++; return []; }
  ]);
  await r.maybeRefresh(1000);   // first call: lastRefreshMs is "now" from constructor → skip
  expect(callCount).toBe(0);
  await r.maybeRefresh(0);      // throttle 0 → always fires
  expect(callCount).toBe(1);
  await r.maybeRefresh(60_000); // immediately after a refresh → skip
  expect(callCount).toBe(1);
});

test("SkillRegistry: refresh is a no-op when no loaders are wired", async () => {
  const r = new SkillRegistry([[entry({ name: "stuck" })]]);
  await r.refresh();   // no loaders set → nothing happens
  expect(r.getByScope("manager").length).toBe(1);
  expect(r.getByScope("manager")[0]!.name).toBe("stuck");
});

test("SkillRegistry: listAll returns every entry regardless of scope", () => {
  const r = new SkillRegistry([[
    entry({ name: "a", scope: ["manager"] }),
    entry({ name: "b", scope: ["worker"] })
  ]]);
  const all = r.listAll();
  expect(all.length).toBe(2);
  expect(all.map((e) => e.name).sort()).toEqual(["a", "b"]);
});
