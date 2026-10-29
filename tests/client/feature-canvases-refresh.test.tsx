import { expect, test } from "bun:test";
import { act } from "react";
import { useFeatureCanvases, type FeatureCanvasesState } from "@/routes/window/use-feature-canvases";
import type { CanvasListItemDto } from "@shared/api-contracts";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

/** How a worker's canvas list stays current: refetched when one of its
 *  canvases is updated (a burst coalesces into one request) and after an SSE
 *  reconnect, one request at a time. The SSE event reaching the page as
 *  mandate:canvas-updated is tested with the listeners; rendering the list,
 *  with FeatureCanvasList. */

function artifact(title: string, featureId = "refresh-a"): CanvasListItemDto {
  return {
    id: title, title, kind: "report", scope: "worker", scopeId: featureId, featureId,
    projectId: "p", projectName: "P", projectSlug: "p", featureName: featureId, featureSlug: featureId,
    threadId: "t", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z"
  };
}

const list = (...titles: string[]) => Response.json({ canvases: titles.map((title) => artifact(title)) });

let state: FeatureCanvasesState;
function Probe({ featureId }: { featureId: string }) {
  state = useFeatureCanvases(featureId);
  return null;
}

/** Every request for these tests' features, held until the test answers it.
 *  Their own feature ids: a hook another file mounted for another feature
 *  must not count here (one process runs every file in a serial run). */
function heldRequests() {
  const requests: Array<{ featureId: string; signal: AbortSignal | null | undefined; answer(response: Response): void }> = [];
  mockFetch((call) => new Promise<Response>((answer) => {
    const featureId = call.url.split("/")[3]!;
    if (featureId.startsWith("refresh-")) requests.push({ featureId, signal: call.init?.signal, answer });
    else answer(Response.json({ canvases: [] }));
  }));
  return requests;
}

const updated = (featureId: string | null | undefined, canvasId = "c") => act(() => {
  window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: featureId === undefined ? { canvasId } : { canvasId, featureId } }));
});
/** Longer than the 100ms window a burst coalesces in. */
const pastWindow = () => settle(150);
const titles = () => state.canvases?.map((canvas) => canvas.title) ?? null;

async function opened(featureId = "refresh-a") {
  const requests = heldRequests();
  const view = await mountAsync(<Probe featureId={featureId} />);
  await settle(10);
  expect(requests).toHaveLength(1);
  requests[0]!.answer(list("Original"));
  await settle();
  expect(titles()).toEqual(["Original"]);
  return { requests, view };
}

test("updates to other features' canvases, or to no feature's, fetch nothing; a burst for this one fetches once", async () => {
  const { requests } = await opened();
  for (let i = 0; i < 20; i++) {
    updated("other-feature");
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
  await settle();
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
  await settle();
  expect(titles()).toEqual(["Recovered"]);
});

test("moving to another feature cancels the first one's request and stops listening for it", async () => {
  const { requests, view } = await opened();
  updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(2);
  view.rerender(<Probe featureId="refresh-b" />);
  await settle(10);
  expect(requests[1]!.signal?.aborted).toBe(true);
  expect(requests.map((request) => request.featureId)).toStrictEqual(["refresh-a", "refresh-a", "refresh-b"]);
  requests[2]!.answer(Response.json({ canvases: [artifact("Other", "refresh-b")] }));
  await settle();
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
  await settle();
  expect(state.error).toBe("Artifacts temporarily unavailable");
  updated("refresh-a");
  await pastWindow();
  expect(requests).toHaveLength(3);
  requests[2]!.answer(list("Original"));
  await settle();
  expect([titles(), state.error]).toEqual([["Original"], null]);
});

test("leaving before a coalesced refresh starts fetches nothing", async () => {
  const { requests, view } = await opened();
  updated("refresh-a");
  view.unmount();
  await pastWindow();
  expect(requests).toHaveLength(1);
});
