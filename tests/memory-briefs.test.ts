import { expect, test } from "bun:test";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { entriesDigest } from "../src/server/modules/memory/briefs.js";

test("a brief is stored per scope and project, and replaced in place", () => {
  const env = freshStoresEnv("md-memory-briefs-");
  const provider = new LocalMemoryProvider(env.store.db);
  expect(provider.getBrief("user", null)).toBeNull();
  provider.putBrief({ scope: "user", projectId: null, content: "u1", inputDigest: "d1", builtAt: "2026-10-07T00:00:00.000Z", runId: "drm_1" });
  provider.putBrief({ scope: "project", projectId: "proj_1", content: "p1", inputDigest: "d2", builtAt: "2026-10-07T00:00:00.000Z", runId: null });
  provider.putBrief({ scope: "user", projectId: null, content: "u2", inputDigest: "d3", builtAt: "2026-10-08T00:00:00.000Z", runId: "drm_2" });
  expect(provider.getBrief("user", null)).toEqual({ scope: "user", projectId: null, content: "u2", inputDigest: "d3", builtAt: "2026-10-08T00:00:00.000Z", runId: "drm_2" });
  expect(provider.listBriefs().map((b) => [b.scope, b.projectId])).toEqual([["user", null], ["project", "proj_1"]]);
});

test("the digest changes with any entry's id or update time and ignores order", () => {
  const a = { id: "a", updatedAt: "1" };
  const b = { id: "b", updatedAt: "2" };
  expect(entriesDigest([a, b])).toBe(entriesDigest([b, a]));
  expect(entriesDigest([a, b])).not.toBe(entriesDigest([a, { id: "b", updatedAt: "3" }]));
  expect(entriesDigest([a])).not.toBe(entriesDigest([a, b]));
});
