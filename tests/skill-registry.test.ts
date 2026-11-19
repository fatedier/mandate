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

test("SkillRegistry: later source overrides earlier on name conflict", () => {
  const builtin = entry({ name: "house-style", description: "builtin", sourcePath: "/builtin/house-style/SKILL.md" });
  const user = entry({ name: "house-style", description: "user override", sourcePath: "/home/.mandate/skills/house-style/SKILL.md" });
  const r = new SkillRegistry([[builtin], [user]]);
  const list = r.getByScope("manager");
  expect(list.length).toBe(1);
  expect(list[0]!.description).toBe("user override");
  expect(list[0]!.sourcePath).toBe("/home/.mandate/skills/house-style/SKILL.md");
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

test("The personal agent reads the skills written for managers, except Mandate's own", async () => {
  const r = new SkillRegistry([
    [
      entry({ name: "canvas-artifact", scope: ["manager", "worker"], builtIn: true }),
      entry({ name: "agent-page", scope: ["personal"], builtIn: true })
    ],
    [
      entry({ name: "deploy-notes", scope: ["manager"], loadBody: async () => "how we deploy" }),
      entry({ name: "pane-tricks", scope: ["worker"] })
    ]
  ]);
  expect(r.getByScope("personal").map((e) => e.name)).toEqual(["agent-page", "deploy-notes"]);
  expect(r.getEntry("deploy-notes", "personal")?.name).toBe("deploy-notes");
  expect(await r.loadBody("deploy-notes", "personal")).toBe("how we deploy");
  expect(r.getEntry("canvas-artifact", "personal")).toBeNull();
  expect(await r.loadBody("canvas-artifact", "personal")).toBeNull();
  expect(r.renderManifest("personal")).toContain("- deploy-notes:");
  expect(r.renderManifest("personal")).not.toContain("canvas-artifact");
  // Managers and workers read as before.
  expect(r.getByScope("manager").map((e) => e.name)).toEqual(["canvas-artifact", "deploy-notes"]);
  expect(r.getByScope("worker").map((e) => e.name)).toEqual(["canvas-artifact", "pane-tricks"]);
});

test("a skill's appendix follows its body, whichever source the skill came from", async () => {
  const appendices = new Map([["canvas-artifact", () => "## The page contract\n\nWhat the viewer does."]]);
  const builtin = entry({ name: "canvas-artifact", scope: ["manager"], builtIn: true, loadBody: async () => "Built-in guidance.\n" });
  const r = new SkillRegistry([[builtin, entry({ name: "notes", scope: ["manager"] })]], appendices);
  expect(await r.loadBody("canvas-artifact", "manager")).toBe("Built-in guidance.\n\n## The page contract\n\nWhat the viewer does.");
  expect(await r.loadBody("notes", "manager")).toBe("body");
  // A scope that cannot read the skill gets neither.
  expect(await r.loadBody("canvas-artifact", "worker")).toBeNull();
  // The user's own canvas-artifact replaces the guidance, not what the viewer does.
  const user = entry({ name: "canvas-artifact", scope: ["manager"], loadBody: async () => "My guidance." });
  const overridden = new SkillRegistry([[builtin], [user]], appendices);
  expect(await overridden.loadBody("canvas-artifact", "manager")).toBe("My guidance.\n\n## The page contract\n\nWhat the viewer does.");
});
