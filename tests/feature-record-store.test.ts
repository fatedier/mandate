import { expect, test } from "bun:test";
import { freshStoresEnv, seedFeature, seedProject } from "./helpers/fixtures.js";
import { FeatureRecordStore, firstLineOf } from "../src/server/modules/plans/record-store.js";

// A worker's task record lives beside its plan: one per worker, rewritten in
// place by memory extraction, found by the words it holds (Chinese split into
// words as chat history is) and gone with its worker.

function clock(start = Date.UTC(2026, 9, 20, 8, 0, 0)) {
  let tick = 0;
  return () => new Date(start + 60_000 * tick++).toISOString();
}

function env(prefix: string) {
  const e = freshStoresEnv(prefix);
  const records = new FeatureRecordStore(e.store.db, clock());
  return { ...e, records };
}

function write(records: FeatureRecordStore, featureId: string, projectId: string, content: string) {
  return records.write({ featureId, projectId, content, sourceThreadId: null, metadata: null });
}

test("write creates a record, then rewrites it in place", () => {
  const { projects, features, records } = env("md-records-write-");
  const projectId = seedProject(projects);
  const featureId = seedFeature(features, projectId);
  const first = write(records, featureId, projectId, "Draft the release notes\nAsked for a summary.");
  expect(first.created).toBe(true);
  expect(first.record.id).toMatch(/^mem_/);
  const second = write(records, featureId, projectId, "Draft the release notes\nSummary sent; links still open.");
  expect(second.created).toBe(false);
  expect(second.record.id).toBe(first.record.id);
  expect(second.record.updatedAt > first.record.updatedAt).toBe(true);
  expect(second.record.createdAt).toBe(first.record.createdAt);
  expect(records.get(featureId)?.content).toBe("Draft the release notes\nSummary sent; links still open.");
});

test("getById finds a record by its id", () => {
  const { projects, features, records } = env("md-records-byid-");
  const projectId = seedProject(projects);
  const featureId = seedFeature(features, projectId);
  const { record } = write(records, featureId, projectId, "Fix the flaky upload test");
  expect(records.getById(record.id)?.featureId).toBe(featureId);
  expect(records.getById("mem_missing")).toBeNull();
});

test("recent lists a project's newest records with the worker's name", () => {
  const { projects, features, records } = env("md-records-recent-");
  const projectId = seedProject(projects);
  const otherProject = seedProject(projects, { name: "Q", tmuxSessionName: "md-q" });
  const a = seedFeature(features, projectId, { name: "notes", tmuxWindowName: "notes" });
  const b = seedFeature(features, projectId, { name: "upload", tmuxWindowName: "upload" });
  const c = seedFeature(features, projectId, { name: "docs", tmuxWindowName: "docs" });
  const elsewhere = seedFeature(features, otherProject, { name: "elsewhere", tmuxWindowName: "elsewhere" });
  write(records, a, projectId, "Draft the release notes\nmore");
  write(records, b, projectId, "Fix the flaky upload test");
  write(records, c, projectId, "Rewrite the setup guide");
  write(records, elsewhere, otherProject, "Not this project");
  features.archive(a);
  expect(records.recent(projectId, { limit: 5 }).map((r) => [r.workerName, r.firstLine])).toEqual([
    ["docs", "Rewrite the setup guide"],
    ["upload", "Fix the flaky upload test"],
    ["notes", "Draft the release notes"]
  ]);
  expect(records.recent(projectId, { limit: 5, excludeFeatureId: b }).map((r) => r.workerName)).toEqual(["docs", "notes"]);
  expect(records.recent(projectId, { limit: 2 }).map((r) => r.workerName)).toEqual(["docs", "upload"]);
  const long = `${"x".repeat(300)}\nsecond line`;
  write(records, c, projectId, long);
  expect(records.recent(projectId, { limit: 1 })[0]!.firstLine).toBe(firstLineOf(long));
  expect(records.hasAny(projectId)).toBe(true);
  expect(records.hasAny(seedProject(projects, { name: "R", tmuxSessionName: "md-r" }))).toBe(false);
});

test("search finds a Chinese word inside a clause", () => {
  const { projects, features, records } = env("md-records-cjk-");
  const projectId = seedProject(projects);
  const featureId = seedFeature(features, projectId);
  write(records, featureId, projectId, "排查部署脚本里漏掉的备份步骤\n过程：看了三次失败的运行\n结论：先备份数据库");
  const hits = records.search({ query: "备份", projectIds: [projectId], limit: 5 });
  expect(hits.map((h) => h.featureId)).toEqual([featureId]);
  expect(hits[0]!.lines).toEqual(["排查部署脚本里漏掉的备份步骤", "结论：先备份数据库"]);
  write(records, featureId, projectId, `${"备份".repeat(150)}\n备份 again\n备份 a third time`);
  const [hit] = records.search({ query: "备份", projectIds: [projectId], limit: 5 });
  expect(hit!.lines.length).toBe(2);
  expect(hit!.lines.every((line) => line.length <= 200)).toBe(true);
});

test("search ranks by relevance, then by recency", () => {
  const { projects, features, records } = env("md-records-rank-");
  const projectId = seedProject(projects);
  const once = seedFeature(features, projectId, { name: "once", tmuxWindowName: "once" });
  const often = seedFeature(features, projectId, { name: "often", tmuxWindowName: "often" });
  const sameA = seedFeature(features, projectId, { name: "same-a", tmuxWindowName: "same-a" });
  const sameB = seedFeature(features, projectId, { name: "same-b", tmuxWindowName: "same-b" });
  write(records, often, projectId, "upload retries\nupload timeout\nupload size limit\nupload check");
  write(records, once, projectId, "a long record about many things, the upload among them, and docs, and notes, and more words around it");
  expect(records.search({ query: "upload", projectIds: [projectId], limit: 5 }).map((h) => h.workerName).slice(0, 2)).toEqual(["often", "once"]);
  write(records, sameA, projectId, "cache key");
  write(records, sameB, projectId, "cache key");
  expect(records.search({ query: "cache", projectIds: [projectId], limit: 5 }).map((h) => h.workerName)).toEqual(["same-b", "same-a"]);
});

test("search scopes by projectIds, featureId and excludeFeatureId", () => {
  const { projects, features, records } = env("md-records-scope-");
  const p = seedProject(projects);
  const q = seedProject(projects, { name: "Q", tmuxSessionName: "md-q" });
  const a = seedFeature(features, p, { name: "a", tmuxWindowName: "a" });
  const b = seedFeature(features, p, { name: "b", tmuxWindowName: "b" });
  const c = seedFeature(features, q, { name: "c", tmuxWindowName: "c" });
  for (const [f, project] of [[a, p], [b, p], [c, q]] as const) write(records, f, project, "migration notes");
  const names = (input: Partial<Parameters<FeatureRecordStore["search"]>[0]>) =>
    records.search({ query: "migration", projectIds: [p], limit: 5, ...input }).map((h) => h.workerName).sort();
  expect(names({})).toEqual(["a", "b"]);
  expect(names({ projectIds: [p, q] })).toEqual(["a", "b", "c"]);
  expect(names({ projectIds: [] })).toEqual([]);
  expect(names({ featureId: b })).toEqual(["b"]);
  expect(names({ excludeFeatureId: a })).toEqual(["b"]);
  expect(records.search({ query: "migration", projectIds: [p, q], limit: 2 }).length).toBe(2);
  expect(names({ query: "  " })).toEqual([]);
});

test("search applies since/until on updatedAt only when given", () => {
  const { projects, features, records } = env("md-records-time-");
  const projectId = seedProject(projects);
  const old = seedFeature(features, projectId, { name: "old", tmuxWindowName: "old" });
  const recent = seedFeature(features, projectId, { name: "recent", tmuxWindowName: "recent" });
  const r1 = write(records, old, projectId, "deploy checklist").record;
  const r2 = write(records, recent, projectId, "deploy checklist").record;
  const names = (range: { since?: string | null; until?: string | null }) =>
    records.search({ query: "deploy", projectIds: [projectId], limit: 5, ...range }).map((h) => h.workerName).sort();
  expect(names({})).toEqual(["old", "recent"]);
  expect(names({ since: r2.updatedAt })).toEqual(["recent"]);
  expect(names({ until: r1.updatedAt })).toEqual(["old"]);
  expect(names({ since: null, until: null })).toEqual(["old", "recent"]);
});

test("deleting the feature removes its record and its index row", () => {
  const { store, projects, features, records } = env("md-records-delete-");
  const projectId = seedProject(projects);
  const featureId = seedFeature(features, projectId);
  write(records, featureId, projectId, "Rotate the signing key");
  store.db.prepare("delete from features where id = ?").run(featureId);
  expect(records.get(featureId)).toBeNull();
  expect(records.search({ query: "signing", projectIds: [projectId], limit: 5 })).toEqual([]);
  expect((store.db.prepare("select count(*) as n from feature_record_words").get() as { n: number }).n).toBe(0);
});

test("reindex reads every record again, and says when another ICU split them", () => {
  const { store, projects, features, records } = env("md-records-reindex-");
  const projectId = seedProject(projects);
  const a = seedFeature(features, projectId, { name: "a", tmuxWindowName: "a" });
  const b = seedFeature(features, projectId, { name: "b", tmuxWindowName: "b" });
  write(records, a, projectId, "数据库备份");
  write(records, b, projectId, "日志轮转");
  expect(records.reindex()).toEqual({ read: 2, icuChanged: false });
  store.db.prepare("update feature_record_words_state set value = 'icu-old' where key = 'version'").run();
  store.db.prepare("delete from feature_record_words").run();
  expect(records.reindex()).toEqual({ read: 2, icuChanged: true });
  expect(records.search({ query: "备份", projectIds: [projectId], limit: 5 }).map((h) => h.workerName)).toEqual(["a"]);
  expect(records.reindex()).toEqual({ read: 2, icuChanged: false });
});

// The words are kept by the record's rowid, which a VACUUM may renumber: the
// table has no INTEGER PRIMARY KEY. Read again, each record is found by its
// own words, never another's.
test("after its records are renumbered, reindex finds each by its own words again", () => {
  const { store, projects, features, records } = env("md-records-renumber-");
  const projectId = seedProject(projects);
  const a = seedFeature(features, projectId, { name: "a", tmuxWindowName: "a" });
  const b = seedFeature(features, projectId, { name: "b", tmuxWindowName: "b" });
  write(records, a, projectId, "数据库备份");
  write(records, b, projectId, "日志轮转");
  // As a VACUUM may leave them: the two rowids swapped.
  store.db.exec("drop trigger feature_records_words_delete");
  store.db.exec("update feature_records set rowid = -rowid; update feature_records set rowid = 3 + rowid");
  const found = (query: string) => records.search({ query, projectIds: [projectId], limit: 5 }).map((h) => h.workerName);
  expect(found("备份")).toEqual(["b"]);
  records.reindex();
  expect([found("备份"), found("轮转")]).toEqual([["a"], ["b"]]);
});
