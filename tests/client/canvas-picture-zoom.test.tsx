import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { useState } from "react";
import { CanvasHtmlView } from "@/routes/canvas/CanvasHtmlView";
import { useCanvasPictures } from "@/routes/canvas/canvas-pictures";
import { canvasAssetsUrl } from "@/routes/canvas/canvas-srcdoc";
import type { CanvasDocumentDto } from "@shared/api-contracts";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";

// A picture pressed in a report opens over the page in the picture viewer,
// paging through the report's pictures; only pictures from the report's own
// folder (or in it as data) open.

afterEach(() => { runCleanups(); });

const CANVAS: CanvasDocumentDto = {
  id: "cnv_1", title: "Atlas checkout screenshots", kind: "report", html: "<h1>Hi</h1>", contentRevision: 1,
  scope: "worker", scopeId: "f1", projectId: "p1", projectName: "P", projectSlug: "p",
  workerId: "f1", workerName: "F", workerSlug: "f", threadId: "t1",
  createdAt: "2026-11-05T09:00:00.000Z", updatedAt: "2026-11-05T09:00:00.000Z"
};
const VIEW = { desktop: null, zoom: null };
const RESOLVED = { desktop: false, zoom: 1, fit: true, layoutWidth: 390 };

/** As CanvasView draws a report: the frame keyed by its revision (a
 *  republish remounts it), the pictures' viewer outside it. */
function Report({ revision, pictures = true }: { revision: number; pictures?: boolean }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const { onPictures, viewer } = useCanvasPictures(CANVAS.id, () => box?.querySelector("iframe") ?? null);
  return (
    <div ref={setBox}>
      <CanvasHtmlView key={revision} canvas={{ ...CANVAS, html: `<h1>Revision ${revision}</h1>` }} view={VIEW} resolved={RESOLVED} onViewChange={() => {}} {...(pictures ? { onPictures } : {})} />
      {viewer}
    </div>
  );
}

let mounted: Awaited<ReturnType<typeof mountAsync>> | null = null;
async function render(pictures?: boolean) {
  mounted = await mountAsync(<Report revision={1} pictures={pictures} />);
  return mounted.host.querySelector("iframe")!;
}
const post = (frame: HTMLIFrameElement, data: Record<string, unknown>) => act(() => {
  window.dispatchEvent(new window.MessageEvent("message", { data, source: frame.contentWindow as Window }));
});
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const shown = () => dialog()?.querySelector("img")?.getAttribute("src") ?? null;
const counter = () => document.querySelector('[data-slot="lightbox-count"]')?.textContent ?? null;
const assets = (name: string) => new URL(name, canvasAssetsUrl("cnv_1")).href;

test("a picture pressed opens over the page; ‹ › page through the report's pictures, wrapping round", async () => {
  const frame = await render();
  const pictures = [
    { src: assets("shots/a.png"), caption: "a Opened and saved" },
    { src: assets("shots/b.png"), caption: "" },
    { src: "data:image/png;base64,AAAA", caption: "c Invalid input blocked" }
  ];
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_1", index: 1, pictures });
  expect([shown(), counter()]).toEqual([assets("shots/b.png"), "2 / 3"]);
  act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Next picture"]')!.click(); });
  expect([shown(), counter()]).toEqual(["data:image/png;base64,AAAA", "3 / 3 · c Invalid input blocked"]);
  act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Next picture"]')!.click(); });
  expect(counter()).toBe("1 / 3 · a Opened and saved");
  act(() => { document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click(); });
  expect(dialog() === null).toBe(true);
  // The keys scroll the report again: it has the focus back (Radix gives it
  // a tick after the close).
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.activeElement === frame).toBe(true);
});

test("only pictures from the report's own folder or in it as data open; another canvas's message opens nothing", async () => {
  const frame = await render();
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_1", index: 0, pictures: [{ src: "https://tracker.example/p.png", caption: "" }] });
  expect(dialog() === null).toBe(true);
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_1", index: 0, pictures: [{ src: "javascript:alert(1)", caption: "" }] });
  expect(dialog() === null).toBe(true);
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_2", index: 0, pictures: [{ src: assets("a.png"), caption: "" }] });
  expect(dialog() === null).toBe(true);
  // Outside ones are left out of the paging; the one pressed still opens.
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_1", index: 1, pictures: [{ src: "https://tracker.example/p.png", caption: "" }, { src: assets("a.png"), caption: "" }] });
  expect([shown(), counter()]).toEqual([assets("a.png"), null]);
});

test("a frame told not to open pictures (Personal agent's page) opens none", async () => {
  const frame = await render(false);
  expect(frame.getAttribute("srcdoc")).not.toContain("mandate.canvas.picture");
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_1", index: 0, pictures: [{ src: assets("a.png"), caption: "" }] });
  expect(dialog() === null).toBe(true);
});

test("a report republished while its picture is open: the picture stays, pages on, and closing gives the new report the focus", async () => {
  const frame = await render();
  const pictures = [{ src: assets("shots/a.png"), caption: "a" }, { src: assets("shots/b.png"), caption: "b" }];
  await post(frame, { type: "mandate.canvas.picture", canvasId: "cnv_1", index: 0, pictures });
  expect(counter()).toBe("1 / 2 · a");
  await act(async () => { mounted!.rerender(<Report revision={2} />); });
  const fresh = mounted!.host.querySelector("iframe")!;
  expect(fresh === frame).toBe(false);
  expect(counter()).toBe("1 / 2 · a");
  act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="Next picture"]')!.click(); });
  expect(counter()).toBe("2 / 2 · b");
  act(() => { document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(document.activeElement === fresh).toBe(true);
});
