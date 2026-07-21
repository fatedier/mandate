import { expect, test } from "bun:test";
import { useProjectsStore } from "../src/client/store/projects.js";

test("projects store: initial state empty", () => {
  useProjectsStore.setState({ projects: [], byId: {} });
  const s = useProjectsStore.getState();
  expect(s.projects).toEqual([]);
  expect(s.byId).toEqual({});
});

test("projects store: setProjects builds byId index", () => {
  useProjectsStore.getState().setProjects([
    { id: "a", name: "A", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-a", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true, features: [] },
    { id: "b", name: "B", workingDir: "/b", isGit: false, gitRemote: null, tmuxSessionName: "md-b", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true, features: [] }
  ]);
  const s = useProjectsStore.getState();
  expect(s.projects.length).toBe(2);
  expect(s.byId.a.name).toBe("A");
});

test("projects store: addProject prepends + indexes", () => {
  useProjectsStore.setState({ projects: [], byId: {} });
  useProjectsStore.getState().addProject({
    id: "x", name: "X", workingDir: "/x", isGit: false, gitRemote: null,
    tmuxSessionName: "md-x", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true, features: []
  });
  const s = useProjectsStore.getState();
  expect(s.projects.length).toBe(1);
  expect(s.byId.x.name).toBe("X");
});

test("projects store: addFeature appends to project's features", () => {
  useProjectsStore.setState({ projects: [], byId: {} });
  useProjectsStore.getState().addProject({
    id: "p", name: "P", workingDir: "/p", isGit: false, gitRemote: null,
    tmuxSessionName: "md-p", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true, features: []
  });
  useProjectsStore.getState().addFeature("p", {
    id: "f1", projectId: "p", name: "F", mode: "shared-cwd", branch: null,
    worktreePath: null, tmuxWindowName: "f", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true
  });
  const s = useProjectsStore.getState();
  expect(s.byId.p.features.length).toBe(1);
  expect(s.byId.p.features[0].name).toBe("F");
});

test("projects store: removeProject removes by id", () => {
  useProjectsStore.setState({
    projects: [{ id: "a", name: "A", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-a", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true, features: [] }],
    byId: { a: { id: "a", name: "A", workingDir: "/a", isGit: false, gitRemote: null, tmuxSessionName: "md-a", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true, features: [] } }
  });
  useProjectsStore.getState().removeProject("a");
  const s = useProjectsStore.getState();
  expect(s.projects.length).toBe(0);
  expect(s.byId.a).toBe(undefined);
});

test("projects store: removeFeature scrubs from project's features", () => {
  useProjectsStore.setState({ projects: [], byId: {} });
  useProjectsStore.getState().addProject({
    id: "p", name: "P", workingDir: "/p", isGit: false, gitRemote: null,
    tmuxSessionName: "md-p", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true,
    features: [{ id: "f1", projectId: "p", name: "F", mode: "shared-cwd", branch: null, worktreePath: null, tmuxWindowName: "f", ownership: "app", createdAt: "x", updatedAt: "x", archivedAt: null, tmuxAlive: true }]
  });
  useProjectsStore.getState().removeFeature("p", "f1");
  const s = useProjectsStore.getState();
  expect(s.byId.p.features.length).toBe(0);
});
