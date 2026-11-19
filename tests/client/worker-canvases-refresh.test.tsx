import { expect, jest, test } from "bun:test";
import { act } from "react";
import { useWorkerCanvases, type WorkerCanvasesState } from "@/routes/window/use-worker-canvases";
import type { CanvasListItemDto } from "@shared/api-contracts";
import { fakeClock } from "../helpers/fake-clock.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync } from "../helpers/mount.js";

/** How a worker's canvas list stays current: refetched when one of its
 *  canvases is updated (a burst coalesces into one request) and after an SSE
 *  reconnect, one request at a time. The SSE event reaching the page as
 *  mandate:canvas-updated is tested with the listeners; rendering the list,
 *  with WorkerCanvasList. */

function artifact(title: string, workerId = "refresh-a"): CanvasListItemDto {
  return {
    id: title, title, kind: "report", scope: "worker", scopeId: workerId, workerId,
    projectId: "p", projectName: "P", projectSlug: "p", workerName: workerId, workerSlug: workerId,
    threadId: "t", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z"
  };
}

const list = (...titles: string[]) => Response.json({ canvases: titles.map((title) => artifact(title)) });

let state: WorkerCanvasesState;
function Probe({ workerId }: { workerId: string }) {
  state = useWorkerCanvases(workerId);
  return null;
}

/** Every request for these tests' workers, held until the test answers it.
 *  Their own worker ids: a hook another file mounted for another worker
 *  must not count here (one process runs every file in a serial run). */
function heldRequests() {
  const requests: Array<{ workerId: string; signal: AbortSignal | null | undefined; answer(response: Response): void }> = [];
  mockFetch((call) => new Promise<Response>((answer) => {
    const workerId = call.url.split("/")[3]!;
    if (workerId.startsWith("refresh-")) requests.push({ workerId, signal: call.init?.signal, answer });
    else answer(Response.json({ canvases: [] }));
  }));
  return requests;
}

const updated = (workerId: string | null | undefined, canvasId = "c") => act(() => {
  window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: workerId === undefined ? { canvasId } : { canvasId, workerId } }));
});
/** These tests run on the fake clock (opened() starts it): the clock moves on
 *  by `ms`, then the answers already given land. */
const tick = (ms = 0) => act(async () => {
  jest.advanceTimersByTime(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
});
/** Longer than the 100ms window a burst coalesces in. */
const pastWindow = () => tick(150);
const titles = () => state.canvases?.map((canvas) => canvas.title) ?? null;

async function opened(workerId = "refresh-a") {
  fakeClock();
  const requests = heldRequests();
  const view = await mountAsync(<Probe workerId={workerId} />);
  await tick(10);
  expect(requests).toHaveLength(1);
  requests[0]!.answer(list("Original"));
  await tick();
  expect(titles()).toEqual(["Original"]);
  return { requests, view };
}

test("updates to other workers' canvases, or to no worker's, fetch nothing; a burst for this one fetches once", async () => {
  const { requests } = await opened();
  for (let i = 0; i < 20; i++) {
    updated("other-worker");
    updated(null);
  }
  updated(undefined);
  await pastWindow();
  expect(requests).toHaveLength(1);
  for (let i = 0; i < 20; i++) updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(2);
  requests[1]!.answer(list("New"));
  await pastWindow();
  expect([titles(), requests.length]).toEqual([["New"], 2]);
});

test("updates during a request share one follow-up, and the answer in between still shows", async () => {
  const { requests } = await opened();
  updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(2);
  for (let i = 0; i < 20; i++) updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(2);
  requests[1]!.answer(list("Interim"));
  await tick();
  expect(titles()).toEqual(["Interim"]);
  await pastWindow();
  expect(requests).toHaveLength(3);
  requests[2]!.answer(list("Latest"));
  await pastWindow();
  expect([titles(), requests.length]).toEqual([["Latest"], 3]);
});

test("a reconnect fetches the list again, for what was missed meanwhile", async () => {
  const { requests } = await opened();
  act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
  await pastWindow();
  expect(requests).toHaveLength(2);
  requests[1]!.answer(list("Recovered"));
  await tick();
  expect(titles()).toEqual(["Recovered"]);
});

test("moving to another worker cancels the first one's request and stops listening for it", async () => {
  const { requests, view } = await opened();
  updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(2);
  view.rerender(<Probe workerId="refresh-b" />);
  await tick(10);
  expect(requests[1]!.signal?.aborted).toBe(true);
  expect(requests.map((request) => request.workerId)).toStrictEqual(["refresh-a", "refresh-a", "refresh-b"]);
  requests[2]!.answer(Response.json({ canvases: [artifact("Other", "refresh-b")] }));
  await tick();
  expect(titles()).toEqual(["Other"]);
  updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(3);
});

test("a failed request says why, and the next update fetches again", async () => {
  const { requests } = await opened();
  updated("refresh-a");
  await pastWindow();
  requests[1]!.answer(Response.json({ error: "Artifacts temporarily unavailable" }, { status: 503 }));
  await tick();
  expect(state.error).toBe("Artifacts temporarily unavailable");
  updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(3);
  requests[2]!.answer(list("Original"));
  await tick();
  expect([titles(), state.error]).toEqual([["Original"], null]);
});

test("leaving before a coalesced refresh starts fetches nothing", async () => {
  const { requests, view } = await opened();
  updated("refresh-a");
  view.unmount();
  await pastWindow();
  expect(requests).toHaveLength(1);
});
