import { expect, test } from "bun:test";
import { useActivityData } from "@/routes/activity/useActivityData";
import type { ActivityQueryFilters } from "@/routes/activity/useActivityFilters";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

/**
 * The log keeps its last page across a remount, so a reader coming back sees
 * it at once. Between tests it must not: a test that opened the log with no
 * filters left its rows for the next one under the same key, which then read
 * "Couldn't refresh" where it meant "Couldn't load" — only when the files ran
 * in one process, and only in the order that put such a test just before it.
 * The two tests below run in that order on purpose.
 */

const FILTERS: ActivityQueryFilters = {
  status: null, view: null, agent: null, purpose: null, provider: null, model: null,
  scopeType: null, day: null, fallback: null, q: null
};

async function mountLog() {
  let state!: ReturnType<typeof useActivityData>;
  function Probe() {
    state = useActivityData({ filterKey: JSON.stringify(FILTERS), queryFilters: FILTERS });
    return null;
  }
  await mountAsync(<Probe />);
  await settle();
  await settle();
  return () => state;
}

test("a test that loads the log leaves its rows behind for a remount", async () => {
  mockFetch(() => jsonResponse({ calls: [{ id: "llm_kept", createdAt: "2026-08-01T12:00:00.000Z" }] }));
  const state = await mountLog();
  expect(state().calls.map((call) => call.id)).toEqual(["llm_kept"]);
});

test("the next test starts from an empty log, not the last one's rows", async () => {
  mockFetch(() => jsonResponse({ error: "database is locked" }, 500));
  const state = await mountLog();
  expect(state().currentData).toBeNull();
  expect(state().calls).toEqual([]);
});
