import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { freshStoresEnv } from "./helpers/fixtures.js";
import { stub } from "./helpers/typed.js";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { memoryEntryHistory } from "../src/server/modules/memory/browse.js";
import { memoryTextAsLearned } from "../src/shared/memory-last-update.js";
import { memoryModule } from "../src/server/modules/memory/module.js";
import type { AppDeps } from "../src/server/app/deps.js";
import type { MemoryEntriesResponse } from "../src/shared/api-contracts.js";

// A change of a memory's text keeps the version it replaced, one back, and
// when it was replaced. An extraction's rewrite is marked as such; any later
// change of the text drops the mark, so the mark always speaks of the last
// change and the version kept is the one that change replaced.

const { upgradeWebSocket } = createBunWebSocket();

function setup(prefix: string) {
  const env = freshStoresEnv(prefix);
  const provider = new LocalMemoryProvider(env.store.db);
  const app = new Hono();
  memoryModule.mountRoutes?.(app, { deps: stub<AppDeps>({ store: env.store }), upgradeWebSocket });
  return { env, provider, app };
}

const remember = (provider: LocalMemoryProvider, content: string, metadata?: Record<string, unknown>) =>
  provider.remember({ scope: "user", type: "preference", source: "agent", content, ...(metadata ? { metadata } : {}) });

test("a change of the text keeps the version it replaced and when it was replaced", async () => {
  const { provider } = setup("md-memory-last-update-");
  const before = await provider.remember({
    scope: "user", type: "preference", source: "user", userQuote: "short replies", content: "Replies stay short.",
    metadata: { statedAt: "2026-10-01T00:00:00.000Z", note: "kept" }
  });
  const after = (await provider.update({ id: before.id, content: "Replies stay short and in English." }))!;
  expect(after.metadata).toMatchObject({ statedAt: "2026-10-01T00:00:00.000Z", note: "kept" });
  expect(after.metadata?.previous).toEqual({
    content: "Replies stay short.", type: "preference", source: "user", userQuote: "short replies",
    statedAt: "2026-10-01T00:00:00.000Z", updatedAt: before.updatedAt, replacedAt: after.updatedAt, asLearned: true
  });
  expect(after.metadata).not.toHaveProperty("updatedByExtraction");
});

test("a write that leaves the text as it was keeps the last change's record", async () => {
  const { provider } = setup("md-memory-last-update-same-");
  const first = await remember(provider, "Deploys go out on Fridays.");
  const changed = (await provider.update({ id: first.id, content: "Deploys go out on Fridays, after the freeze.", byExtraction: "extract_1" }))!;
  const moved = (await provider.update({ id: first.id, scope: "project", projectId: "proj_1" }))!;
  const same = (await provider.update({ id: first.id, content: "  Deploys go out on Fridays, after the freeze.  " }))!;
  const archived = (await provider.archive(first.id, { forgottenReason: "proved wrong" }))!;
  for (const later of [moved, same, archived]) {
    expect(later.metadata?.previous).toEqual(changed.metadata?.previous);
    expect(later.metadata?.updatedByExtraction).toBe("extract_1");
  }
});

test("an extraction's rewrite is marked; a later change of the text by anyone else drops the mark", async () => {
  const { provider } = setup("md-memory-last-update-mark-");
  const first = await remember(provider, "A.");
  const rewritten = (await provider.update({ id: first.id, content: "A. B.", byExtraction: "extract_1" }))!;
  expect(rewritten.metadata).toMatchObject({ updatedByExtraction: "extract_1", previous: { content: "A.", replacedAt: rewritten.updatedAt } });
  // The dream writes the metadata it read back, the mark with it.
  const dreamed = (await provider.update({ id: first.id, content: "A, then B.", metadata: { ...rewritten.metadata, dreamRunId: "drm_1" } }))!;
  expect(dreamed.metadata).not.toHaveProperty("updatedByExtraction");
  expect(dreamed.metadata).toMatchObject({ dreamRunId: "drm_1", previous: { content: "A. B.", replacedAt: dreamed.updatedAt } });
  const again = (await provider.update({ id: first.id, content: "A, then B, then C.", byExtraction: "extract_2" }))!;
  expect(again.metadata).toMatchObject({ updatedByExtraction: "extract_2", previous: { content: "A, then B." } });
});

test("the entries list can ask for what an extraction rewrote last, newest rewrite first", async () => {
  const { provider, app } = setup("md-memory-last-update-list-");
  const first = await remember(provider, "one");
  const second = await remember(provider, "two");
  const later = await remember(provider, "three");
  await remember(provider, "never rewritten");
  // From before the version kept carried its time: not told, it may be stale.
  await remember(provider, "legacy", { updatedByExtraction: "extract_0", previous: { content: "legacy, before" } });
  await provider.update({ id: first.id, content: "one, more", byExtraction: "extract_1" });
  await Bun.sleep(2);
  await provider.update({ id: second.id, content: "two, more", byExtraction: "extract_2" });
  await provider.update({ id: later.id, content: "three, more", byExtraction: "extract_3" });
  await Bun.sleep(2);
  await provider.update({ id: later.id, content: "three, dreamed", metadata: {} });
  // Moved after its rewrite: still placed by the rewrite.
  await provider.update({ id: first.id, scope: "project", projectId: "proj_1" });
  const body = await (await app.request("/api/memory/entries?status=all&updated=1&limit=25")).json() as MemoryEntriesResponse;
  expect(body.entries.map((entry) => entry.id)).toEqual([second.id, first.id]);
  expect(body.total).toBe(2);
});

test("the history tells an extraction's rewrite, with what it added", async () => {
  const { env, provider } = setup("md-memory-last-update-history-");
  const added = await remember(provider, "Delete only what this task made.");
  const rewritten = (await provider.update({ id: added.id, content: "Delete only what this task made. In a shared folder, check for other threads' files first.", byExtraction: "extract_1" }))!;
  const events = memoryEntryHistory(env.store.db, added.id)!.events;
  expect(events[0]).toEqual({ at: rewritten.updatedAt, text: "Updated from a conversation", detail: "Added: In a shared folder, check for other threads' files first." });

  // Said anew rather than added to: no "Added".
  const reworded = await remember(provider, "Replies are short.");
  await provider.update({ id: reworded.id, content: "Keep every reply short.", byExtraction: "extract_2" });
  expect(memoryEntryHistory(env.store.db, reworded.id)!.events[0]).toEqual(expect.objectContaining({ text: "Updated from a conversation" }));
  expect(memoryEntryHistory(env.store.db, reworded.id)!.events[0]).not.toHaveProperty("detail");

  // Changed since by someone else, or from before the time was kept: not told.
  await provider.update({ id: added.id, content: "Delete only what this task made, and look first.", metadata: {} });
  const legacy = await remember(provider, "legacy", { updatedByExtraction: "extract_0", previous: { content: "before" } });
  for (const id of [added.id, legacy.id]) {
    expect(memoryEntryHistory(env.store.db, id)!.events.map((event) => event.text)).not.toContain("Updated from a conversation");
  }
});

// The version kept is the one the memory was learned as only when no change
// of its text came before; a write that left the text (a restatement in the
// user's words, a move) does not make that unknown.
test("the version kept says when it is the text the memory was learned as", async () => {
  const { provider } = setup("md-memory-last-update-learned-");
  const first = await remember(provider, "Keep replies short.");
  await provider.update({ id: first.id, metadata: { statedAt: "2026-10-01T00:00:00.000Z" } });
  await provider.update({ id: first.id, scope: "project", projectId: "proj_1" });
  const once = (await provider.update({ id: first.id, content: "Keep replies short. Use English.", byExtraction: "extract_1" }))!;
  expect(once.metadata?.previous).toMatchObject({ content: "Keep replies short.", asLearned: true });
  expect(memoryTextAsLearned(once)).toBe("Keep replies short.");
  const twice = (await provider.update({ id: first.id, content: "Keep replies short. Use English. No headings.", byExtraction: "extract_2" }))!;
  expect(twice.metadata?.previous).not.toHaveProperty("asLearned");
  expect(memoryTextAsLearned(twice)).toBe("Keep replies short. Use English. No headings.");
});

test("a memory written before the store kept track is not taken as learned as it is", async () => {
  const { env, provider } = setup("md-memory-last-update-unknown-");
  const old = await remember(provider, "Deploys go out on Fridays.");
  // Changed once by a writer that kept nothing, as before this store did.
  env.store.db.prepare("update memory_entries set content = ?, updated_at = ? where id = ?")
    .run("Deploys go out on Fridays, after the freeze.", "2030-01-01T00:00:00.000Z", old.id);
  const rewritten = (await provider.update({ id: old.id, content: "Deploys go out on Fridays, after the freeze and the review.", byExtraction: "extract_1" }))!;
  expect(rewritten.metadata?.previous).not.toHaveProperty("asLearned");
  expect(memoryTextAsLearned(rewritten)).toBe("Deploys go out on Fridays, after the freeze and the review.");
});
