import { expect, test } from "bun:test";
import { LocalMemoryProvider } from "../src/server/modules/memory/local-provider.js";
import { freshStoresEnv, seedProject } from "./helpers/fixtures.js";

const tempStore = () => freshStoresEnv("md-test-");

test("ProjectsStore: insert + getById round-trip", () => {
  const { projects, cleanup } = tempStore();
  try {
    const id = projects.insert({
      name: "My App",
      workingDir: "/tmp/foo",
      isGit: true,
      gitRemote: "git@github.com:me/foo.git",
      tmuxSessionName: "md-my_app",
      ownership: "app"
    });
    const row = projects.getById(id);
    expect(row).toBeTruthy();
    expect(row!.name).toBe("My App");
    expect(row!.workingDir).toBe("/tmp/foo");
    expect(row!.isGit).toBe(true);
    expect(row!.gitRemote).toBe("git@github.com:me/foo.git");
    expect(row!.tmuxSessionName).toBe("md-my_app");
    expect(row!.ownership).toBe("app");
    expect(row!.archivedAt).toBe(null);
  } finally { cleanup(); }
});

test("ProjectsStore: getActiveByTmuxSessionName resolves by session name", () => {
  const { projects, cleanup } = tempStore();
  try {
    const id = projects.insert({
      name: "Local",
      workingDir: "/srv/app",
      isGit: false,
      gitRemote: null,
      tmuxSessionName: "md-local",
      ownership: "app"
    });
    const row = projects.getActiveByTmuxSessionName("md-local");
    expect(row?.id).toBe(id);
    expect(projects.getActiveByTmuxSessionName("missing")).toBe(null);
  } finally { cleanup(); }
});

test("ProjectsStore: listActive excludes archived", () => {
  const { projects, cleanup } = tempStore();
  try {
    const id1 = projects.insert({ name: "A", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-a", ownership: "app" });
    const id2 = projects.insert({ name: "B", workingDir: "/b", isGit: false, gitRemote: null, tmuxSessionName: "md-b", ownership: "app" });
    projects.archive(id2);
    const active = projects.listActive();
    expect(active.length).toBe(1);
    expect(active[0].id).toBe(id1);
  } finally { cleanup(); }
});

test("ProjectsStore: insert rejects duplicate name", () => {
  const { projects, cleanup } = tempStore();
  try {
    projects.insert({ name: "Dup", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-dup", ownership: "app" });
    expect(() => projects.insert({
      name: "Dup", workingDir: "/b", isGit: false, gitRemote: null, tmuxSessionName: "md-dup-2", ownership: "app"
    })).toThrow(/UNIQUE/i);
  } finally { cleanup(); }
});

test("ProjectsStore: insert rejects duplicate tmuxSessionName", () => {
  const { projects, cleanup } = tempStore();
  try {
    projects.insert({ name: "A", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-shared", ownership: "app" });
    expect(() => projects.insert({
      name: "B", workingDir: "/b", isGit: false, gitRemote: null, tmuxSessionName: "md-shared", ownership: "app"
    })).toThrow(/UNIQUE/i);
  } finally { cleanup(); }
});

test("ProjectsStore: archive sets archivedAt and getById still returns the row", () => {
  const { projects, cleanup } = tempStore();
  try {
    const id = projects.insert({ name: "X", workingDir: "/x", isGit: false, gitRemote: null, tmuxSessionName: "md-x", ownership: "app" });
    projects.archive(id);
    const row = projects.getById(id);
    expect(row).toBeTruthy();
    expect(row!.archivedAt).toBeTruthy();
  } finally { cleanup(); }
});

test("ProjectsStore: takenTmuxSessionNames returns set of names from active rows", () => {
  const { projects, cleanup } = tempStore();
  try {
    projects.insert({ name: "A", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-a", ownership: "app" });
    projects.insert({ name: "B", workingDir: "/b", isGit: false, gitRemote: null, tmuxSessionName: "md-b", ownership: "app" });
    const id = projects.insert({ name: "C", workingDir: "/c", isGit: false, gitRemote: null, tmuxSessionName: "md-c", ownership: "app" });
    projects.archive(id);
    const taken = projects.takenTmuxSessionNames();
    expect([...taken].sort()).toEqual(["md-a", "md-b"]);
  } finally { cleanup(); }
});

test("ProjectsStore: archived project frees name and tmuxSessionName for reuse", () => {
  const { projects, cleanup } = tempStore();
  try {
    const id1 = projects.insert({
      name: "Reuse", workingDir: "/a", isGit: false, gitRemote: null,
      tmuxSessionName: "md-reuse", ownership: "app"
    });
    projects.archive(id1);
    // After archive, the same name and tmuxSessionName can be re-used.
    const id2 = projects.insert({
      name: "Reuse", workingDir: "/b", isGit: false, gitRemote: null,
      tmuxSessionName: "md-reuse", ownership: "app"
    });
    expect(id1).not.toBe(id2);
  } finally { cleanup(); }
});

test("ProjectsStore: archiving a project archives the memories only it can reach", async () => {
  const { store, projects, cleanup } = tempStore();
  try {
    const kept = seedProject(projects, { name: "kept", tmuxSessionName: "md-kept" });
    const gone = seedProject(projects, { name: "gone", tmuxSessionName: "md-gone" });
    const provider = new LocalMemoryProvider(store.db, {});

    // One of every scope on the project being archived, plus a project-scoped
    // one belonging to the project that stays. Recall is scoped by project_id,
    // so the first two die with the project and the last two do not — a cascade
    // that took the wrong ones would still pass a test that only counted rows.
    const projectScoped = await provider.remember({
      scope: "project", projectId: gone, kind: "semantic", content: "how gone builds", source: "manual"
    });
    const featureScoped = await provider.remember({
      scope: "feature", projectId: gone, featureId: "feat-1", kind: "semantic",
      content: "how gone tests", source: "manual"
    });
    const globalScoped = await provider.remember({
      scope: "global", projectId: gone, kind: "semantic", content: "how anything builds", source: "manual"
    });
    const neighbour = await provider.remember({
      scope: "project", projectId: kept, kind: "semantic", content: "how kept builds", source: "manual"
    });

    projects.archive(gone);

    const statusOf = (id: string) => (store.db
      .prepare("select status from memory_entries where id = ?")
      .get(id) as { status: string }).status;
    expect(statusOf(projectScoped.id)).toBe("archived");
    expect(statusOf(featureScoped.id)).toBe("archived");
    expect(statusOf(globalScoped.id)).toBe("available");
    expect(statusOf(neighbour.id)).toBe("available");

    // Why, recorded on the row: `dreamLastReviewedAt` and the rest live in the
    // same object, so this has to merge rather than replace.
    const metadata = JSON.parse((store.db
      .prepare("select metadata_json from memory_entries where id = ?")
      .get(projectScoped.id) as { metadata_json: string }).metadata_json ?? "{}");
    expect(metadata.archivedReason).toBe("project_archived");
  } finally { cleanup(); }
});

test("ProjectsStore: archiving twice leaves the first archive's memories alone", () => {
  const { store, projects, cleanup } = tempStore();
  try {
    const id = seedProject(projects, { name: "twice", tmuxSessionName: "md-twice" });
    store.db.prepare(
      "insert into memory_entries (id, scope, project_id, kind, content, status, source, created_at, updated_at)"
      + " values ('m1', 'project', ?, 'semantic', 'x', 'archived', 'manual', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')"
    ).run(id);

    projects.archive(id);

    // The update is bounded to `status = 'available'`, so an entry the reader
    // archived by hand keeps its own updated_at rather than being restamped by
    // an archive that did not touch it.
    const row = store.db.prepare("select updated_at, metadata_json from memory_entries where id = 'm1'")
      .get() as { updated_at: string; metadata_json: string | null };
    expect(row.updated_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.metadata_json).toBe(null);
  } finally { cleanup(); }
});
