import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { useProjectsStore, type ProjectWorker, type Project } from "@/store/projects";
import { mockFetch } from "../helpers/fetch.js";
import { clientWorker, clientProject } from "../helpers/client-builders.js";

const initialTime = "2026-09-01T00:00:00.000Z";
const savedTime = "2026-09-02T00:00:00.000Z";
const newerTime = "2026-09-03T00:00:00.000Z";

function worker(id = "worker", overrides: Partial<ProjectWorker> = {}): ProjectWorker {
  return clientWorker(id, { projectId: "a", createdAt: initialTime, updatedAt: initialTime, ownerThreadId: null, ...overrides });
}

function project(id: string, sortOrder: number, workers: ProjectWorker[] = []): Project {
  return clientProject(id, { name: id, workingDir: `/${id}`, tmuxSessionName: id, sortOrder, createdAt: initialTime, updatedAt: initialTime, workers });
}

function deferResponses() {
  const requests: Array<{
    body: unknown;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];
  mockFetch(({ init }) => new Promise<Response>((resolve, reject) => {
    requests.push({ body: JSON.parse(init!.body as string), resolve, reject });
  }));
  return requests;
}

function pinResponse(pinnedAt: string | null, updatedAt = savedTime): Response {
  return Response.json({ worker: worker("worker", { pinnedAt, updatedAt }) });
}

const state = () => useProjectsStore.getState();
const pinnedAt = () => state().byId.a!.workers.find((f) => f.id === "worker")!.pinnedAt;
const projectIds = () => state().projects.map((p) => p.id);

describe("project mutations", () => {
  let errors: ReturnType<typeof spyOn>;
  beforeEach(() => {
    state().setProjects([project("a", 10, [worker()]), project("b", 20)]);
    errors = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  test("reorder failure restores only ordering while preserving lifecycle updates", async () => {
    const requests = deferResponses();
    const save = state().reorderProjects(["b", "a"]);
    state().addProject(project("c", -10));
    state().removeWorker("a", "worker");
    const added = worker("new-worker", { pinnedAt: newerTime });
    state().addWorker("a", added);
    requests[0]!.resolve(new Response(null, { status: 400 }));
    await save;

    expect(projectIds()).toEqual(["c", "a", "b"]);
    expect(state().projects.map((p) => p.sortOrder)).toEqual([-10, 10, 20]);
    expect(state().byId.a!.workers).toEqual([added]);
    expect(state().bySlug.a).toBe(state().byId.a);
    expect(state().reordering).toBe(false);
  });

  test("reorder rollback never restores an archived project", async () => {
    const requests = deferResponses();
    const save = state().reorderProjects(["b", "a"]);
    state().removeProject("a");
    requests[0]!.reject(new Error("offline"));
    await save;
    expect(projectIds()).toEqual(["b"]);
    expect(state().byId.a).toBeUndefined();
    expect(state().bySlug.a).toBeUndefined();
  });

  for (const setter of ["setProjects", "setProjectsState"] as const) {
    test(`reorder failure preserves a newer authoritative ${setter} snapshot`, async () => {
      const requests = deferResponses();
      const save = state().reorderProjects(["b", "a"]);
      const latest = [project("b", 0), { ...project("a", 1000, [worker("new-worker")]), name: "Renamed" }];
      state()[setter](latest);
      requests[0]!.resolve(new Response(null, { status: 503 }));
      await save;
      expect(state().projects).toBe(latest);
      expect(state().reordering).toBe(false);
    });
  }

  for (const status of [200, 503]) {
    test(`reorder blocks overlapping writes and permits another after HTTP ${status}`, async () => {
      const requests = deferResponses();
      const first = state().reorderProjects(["b", "a"]);
      await state().reorderProjects(["a", "b"]);
      expect(requests).toHaveLength(1);
      expect(state().reordering).toBe(true);
      expect(projectIds()).toEqual(["b", "a"]);
      requests[0]!.resolve(new Response(null, { status }));
      await first;
      const nextIds = status === 200 ? ["a", "b"] : ["b", "a"];
      const second = state().reorderProjects(nextIds);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.body).toEqual({ projectIds: nextIds });
      requests[1]!.resolve(new Response(null, { status: 200 }));
      await second;
      expect(projectIds()).toEqual(nextIds);
      expect(state().reordering).toBe(false);
    });
  }

  test("invalid reorder requests do not lock the controls or send a request", async () => {
    const requests = deferResponses();
    await state().reorderProjects(["a"]);
    await state().reorderProjects(["a", "a"]);
    expect(requests).toHaveLength(0);
    expect(state().reordering).toBe(false);
  });

  test("pin blocks overlapping writes through response body parsing, then allows unpin", async () => {
    const requests = deferResponses();
    const first = state().togglePin("worker");
    let complete!: (value: unknown) => void;
    const body = new Promise((resolve) => { complete = resolve; });
    let parsing!: () => void;
    const startedParsing = new Promise<void>((resolve) => { parsing = resolve; });
    requests[0]!.resolve({ ok: true, json: () => { parsing(); return body; } } as Response);
    await startedParsing;
    await state().togglePin("worker");
    expect(requests).toHaveLength(1);
    expect(state().pinningWorkerIds.has("worker")).toBe(true);
    complete({ worker: worker("worker", { pinnedAt: savedTime, updatedAt: savedTime }) });
    await first;
    expect(pinnedAt()).toBe(savedTime);
    expect(state().pinningWorkerIds.size).toBe(0);

    const second = state().togglePin("worker");
    expect(requests[1]!.body).toEqual({ pinned: false });
    requests[1]!.resolve(pinResponse(null, newerTime));
    await second;
    expect(pinnedAt()).toBeNull();
    expect(state().pinningWorkerIds.size).toBe(0);
  });

  for (const failure of ["http", "network", "json"] as const) {
    test(`failed unpin restores its original timestamp and releases the lock after ${failure} failure`, async () => {
      state().setProjects([project("a", 10, [worker("worker", { pinnedAt: initialTime })])]);
      const requests = deferResponses();
      const save = state().togglePin("worker");
      if (failure === "network") requests[0]!.reject(new Error("offline"));
      else if (failure === "http") requests[0]!.resolve(new Response(null, { status: 500 }));
      else requests[0]!.resolve(new Response("invalid json"));
      await save;
      expect(pinnedAt()).toBe(initialTime);
      expect(state().pinningWorkerIds.size).toBe(0);
      const retry = state().togglePin("worker");
      expect(requests[1]!.body).toEqual({ pinned: false });
      requests[1]!.resolve(pinResponse(null));
      await retry;
      expect(pinnedAt()).toBeNull();
    });
  }

  test("pinning different Workers is independent even when responses arrive in reverse order", async () => {
    state().addWorker("a", worker("other-worker"));
    const requests = deferResponses();
    const first = state().togglePin("worker");
    const second = state().togglePin("other-worker");
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(Response.json({ worker: worker("other-worker", { pinnedAt: newerTime, updatedAt: newerTime }) }));
    await second;
    expect([...state().pinningWorkerIds]).toEqual(["worker"]);
    requests[0]!.resolve(new Response(null, { status: 500 }));
    await first;
    expect(state().byId.a!.workers.map((f) => f.pinnedAt)).toEqual([null, newerTime]);
    expect(state().pinningWorkerIds.size).toBe(0);
  });

  test("reorder rollback preserves a pin saved during the request", async () => {
    const requests = deferResponses();
    const reorder = state().reorderProjects(["b", "a"]);
    const pin = state().togglePin("worker");
    requests[1]!.resolve(pinResponse(savedTime));
    await pin;
    requests[0]!.reject(new Error("offline"));
    await reorder;
    expect(projectIds()).toEqual(["a", "b"]);
    expect(pinnedAt()).toBe(savedTime);
  });

  test("pin failure preserves the latest snapshot even when it confirms the optimistic value", async () => {
    const requests = deferResponses();
    const save = state().togglePin("worker");
    const latest = [project("a", 10, [worker("worker", { pinnedAt: pinnedAt(), name: "Renamed", updatedAt: newerTime })])];
    state().setProjectsState(latest);
    requests[0]!.reject(new Error("response lost"));
    await save;
    expect(state().projects).toBe(latest);
    expect(state().pinningWorkerIds.size).toBe(0);
  });

  test("pin confirmation preserves a newer Worker update and pin state", async () => {
    const requests = deferResponses();
    const save = state().togglePin("worker");
    const latest = worker("worker", { pinnedAt: null, name: "Renamed", updatedAt: newerTime });
    state().setProjectsState([project("a", 10, [latest])]);
    requests[0]!.resolve(pinResponse(savedTime));
    await save;
    expect(state().byId.a!.workers[0]).toBe(latest);
  });

  test("a snapshot from before the pin does not prevent successful confirmation", async () => {
    const requests = deferResponses();
    const save = state().togglePin("worker");
    state().setProjectsState([project("a", 10, [worker()])]);
    requests[0]!.resolve(pinResponse(savedTime));
    await save;
    expect(pinnedAt()).toBe(savedTime);
    expect(state().byId.a!.workers[0]!.updatedAt).toBe(savedTime);
  });

  for (const status of [200, 404]) {
    test(`pin HTTP ${status} does not restore an archived Worker`, async () => {
      const requests = deferResponses();
      const save = state().togglePin("worker");
      state().removeWorker("a", "worker");
      requests[0]!.resolve(status === 200 ? pinResponse(savedTime) : new Response(null, { status }));
      await save;
      expect(state().byId.a!.workers).toEqual([]);
      expect(state().pinningWorkerIds.size).toBe(0);
    });
  }
});
