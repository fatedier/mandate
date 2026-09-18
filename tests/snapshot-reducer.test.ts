import { expect, test } from "bun:test";
import {
  appStateMutations,
  parseSseData
} from "../src/client/lib/snapshot-reducer";
import type { AppStateResponse, SseEventPayloadMap } from "../src/shared/api-contracts";

const projectBase = {
  id: "p1",
  name: "p1",
  workingDir: "/tmp/p1",
  tmuxSessionName: "p1",
  isGit: false,
  gitRemote: null,
  ownership: "app" as const,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  features: [] as never[],
  tmuxAlive: true as const,
  tmuxStatus: "alive" as const
};

test("parseSseData parses MessageEvent.data as JSON", () => {
  const event = new MessageEvent("test", { data: JSON.stringify({ a: 1, b: "two" }) });
  expect(parseSseData<{ a: number; b: string }>(event)).toEqual({ a: 1, b: "two" });
});

test("appStateMutations omits absent fields", () => {
  expect(appStateMutations({} as AppStateResponse)).toEqual({});
});

test("appStateMutations passes snapshot through unchanged", () => {
  const snapshot = { sessions: [] } as unknown as AppStateResponse["snapshot"];
  const result = appStateMutations({ snapshot } as AppStateResponse);
  expect(result.snapshot).toBe(snapshot);
  expect(result.banner).toBeUndefined();
});

test("appStateMutations renders string error as banner verbatim", () => {
  const result = appStateMutations({ error: "boom" } as AppStateResponse);
  expect(result.banner).toBe("boom");
});

test("appStateMutations renders object error to its message", () => {
  const result = appStateMutations({ error: { message: "oops" } } as AppStateResponse);
  expect(result.banner).toBe("oops");
});

test("appStateMutations passes projects through", () => {
  const projects = [{ ...projectBase, id: "a" }] as SseEventPayloadMap["projectsState"];
  const result = appStateMutations({ projects } as AppStateResponse);
  expect(result.projects).toBe(projects);
});
