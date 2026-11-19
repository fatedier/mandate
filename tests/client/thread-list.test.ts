import { expect, test } from "bun:test";
import { NO_VALUE } from "@/lib/filter-parts";
import { labelChoices, listedThreads, matchesFilters, matchesQuery, projectChoices } from "@/routes/threads/thread-list";
import type { ArchivedThreadDto } from "@shared/api/agents";
import { managerThreadDto } from "../helpers/client-builders.js";

// What the Threads page lists and how it narrows it: pure, over the store's
// two lists.

const owner = (name: string) => ({ name, by: "owner" as const });
const archivedEntry = (id: string, patch: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title: id, archivedAt: "2026-10-13T09:00:00.000Z", lastActivityAt: "2026-10-13T09:00:00.000Z", workers: 0, canvases: 0, labels: [], projects: [], ...patch
});

const OPEN = [
  managerThreadDto("thr_a", { title: "Scale recipes per serving", lastActivityAt: "2026-11-01T08:00:00.000Z", labels: [owner("billing"), owner("3.21")], projects: ["atlas-api"] }),
  managerThreadDto("thr_b", { title: "Prices from one source", lastActivityAt: "2026-11-03T08:00:00.000Z", labels: [owner("Billing")], projects: ["atlas-api", "search-server"] }),
  managerThreadDto("thr_duty", {
    title: "Watch the greenhouse", lastActivityAt: "2026-11-02T08:00:00.000Z",
    duty: { level: "investigate", schedules: [] } as never
  })
];
const ARCHIVED = [
  archivedEntry("thr_old", { title: "Cache expiry", archivedAt: "2026-10-12T09:00:00.000Z", labels: [owner("ops")], projects: ["search-server"] }),
  archivedEntry("thr_newer", { title: "Flaky upload", archivedAt: "2026-10-20T09:00:00.000Z" })
];

test("Active lists the open threads by last activity, newest first, a duty thread among them; Archived by when archived", () => {
  const active = listedThreads(OPEN, ARCHIVED, "active");
  expect(active.map((t) => [t.id, t.at, t.archived, t.duty])).toEqual([
    ["thr_b", "2026-11-03T08:00:00.000Z", false, false],
    ["thr_duty", "2026-11-02T08:00:00.000Z", false, true],
    ["thr_a", "2026-11-01T08:00:00.000Z", false, false]
  ]);
  const archived = listedThreads(OPEN, ARCHIVED, "archived");
  expect(archived.map((t) => [t.id, t.at, t.archived, t.duty])).toEqual([
    ["thr_newer", "2026-10-20T09:00:00.000Z", true, false],
    ["thr_old", "2026-10-12T09:00:00.000Z", true, false]
  ]);
  expect(active[0]).toMatchObject({ title: "Prices from one source", labels: [owner("Billing")], projects: ["atlas-api", "search-server"] });
});

test("the search reads titles only, without regard to case", () => {
  const [b, , a] = listedThreads(OPEN, ARCHIVED, "active");
  expect([matchesQuery(a!, "RECIPES"), matchesQuery(a!, "  recipes per "), matchesQuery(a!, ""), matchesQuery(a!, "   ")]).toEqual([true, true, true, true]);
  // Not its labels, not its projects.
  expect([matchesQuery(a!, "billing"), matchesQuery(a!, "atlas-api"), matchesQuery(b!, "recipes")]).toEqual([false, false, false]);
});

test("a thread passes a filter group with any ticked value of it, and must pass both groups", () => {
  const [b, duty, a] = listedThreads(OPEN, ARCHIVED, "active");
  const passes = (filters: { labels: string[]; projects: string[] }) => [a, b, duty].map((t) => matchesFilters(t!, filters));
  expect(passes({ labels: [], projects: [] })).toEqual([true, true, true]);
  // Labels are compared without regard to case.
  expect(passes({ labels: ["BILLING"], projects: [] })).toEqual([true, true, false]);
  expect(passes({ labels: ["3.21", "ops"], projects: [] })).toEqual([true, false, false]);
  expect(passes({ labels: [], projects: ["search-server"] })).toEqual([false, true, false]);
  expect(passes({ labels: ["billing"], projects: ["search-server"] })).toEqual([false, true, false]);
  // No label and No project: the threads that have none, alone or with others.
  expect(passes({ labels: [NO_VALUE], projects: [] })).toEqual([false, false, true]);
  expect(passes({ labels: ["3.21", NO_VALUE], projects: [] })).toEqual([true, false, true]);
  expect(passes({ labels: [], projects: [NO_VALUE] })).toEqual([false, false, true]);
});

test("the choices a filter offers are the names the listed threads carry, each once, sorted", () => {
  const active = listedThreads(OPEN, ARCHIVED, "active");
  // In the spelling of the first thread listed that has it.
  expect(labelChoices(active)).toEqual(["3.21", "Billing"]);
  expect(projectChoices(active)).toEqual(["atlas-api", "search-server"]);
  const archived = listedThreads(OPEN, ARCHIVED, "archived");
  expect([labelChoices(archived), projectChoices(archived)]).toEqual([["ops"], ["search-server"]]);
});
