import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation, type Location } from "react-router";
import { CanvasOpenerProvider } from "@/routes/canvas/CanvasOpenerProvider";
import { CanvasReferenceCard } from "@/routes/window/chat/CanvasReferenceCard";
import { MarkdownView } from "@/components/MarkdownView";
import { PlanNote } from "@/routes/window/plan/PlanNote";
import { FeatureCanvasList } from "@/routes/window/FeatureCanvasList";
import type { FeatureCanvasesState } from "@/routes/window/use-feature-canvases";
import { resetCanvasTitles } from "@/store/canvas-titles";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

// Every way into a canvas asks the page it is on first: a page with a panel
// (a thread, Your agent, on a desktop) shows it in a tab there; any other page
// opens it over itself, as every way did before.

afterEach(() => { runCleanups(); resetCanvasTitles(); });

const HERE = "/threads/thr_a";
let at: Location | null = null;
function Where() {
  at = useLocation();
  return null;
}

const A = "cnv_AaAaAaAaAa1";
const B = "cnv_BbBbBbBbBb2";
const C = "cnv_CcCcCcCcCc3";
const D = "cnv_DdDdDdDdDd4";
const E = "cnv_EeEeEeEeEe5";

const listState: FeatureCanvasesState = {
  featureId: "f1",
  error: null,
  retry: () => {},
  canvases: [{
    id: E, title: "Drill report", kind: "report", scope: "worker", scopeId: "f1", threadId: "thr_w",
    createdAt: "2026-10-28T08:00:00.000Z", updatedAt: "2026-10-28T09:00:00.000Z",
    projectId: "p1", projectName: "project-1", projectSlug: "md-project-1", featureId: "f1", featureName: "rollback drill", featureSlug: "drill"
  }]
};

function everyWay() {
  return (
    <>
      <CanvasReferenceCard title="Release report" path={`/canvas/${A}`} />
      <MarkdownView text={`See [the notes](/canvas/${B}?page=2) and \`/canvas/${C}\`.`} />
      <PlanNote note={`see ${D}`} clamp={false} ctx={{ paneHref: () => null, paneName: () => undefined, canvasTitle: () => "Drill plan", webBase: null, maxStepId: 0 } as never} />
      <FeatureCanvasList state={listState} />
    </>
  );
}

const click = (el: Element | null) => {
  expect(el === null).toBe(false);
  act(() => { (el as HTMLElement).dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
};

test("with no page to open it in, a canvas opens over the page as before", () => {
  const { host } = mount(<MemoryRouter initialEntries={[HERE]}>{everyWay()}<Where /></MemoryRouter>);
  click(host.querySelector(`button[aria-label="Open canvas: Release report"]`));
  expect(at!.pathname).toBe(`/canvas/${A}`);
  expect((at!.state as { backgroundLocation?: Location }).backgroundLocation?.pathname).toBe(HERE);
});

test("inside a page that opens canvases, the card, a link, a bare path, a plan note and the Canvases list all ask that page", () => {
  const asked: string[] = [];
  const { host } = mount(
    <MemoryRouter initialEntries={[HERE]}>
      <CanvasOpenerProvider open={(id) => asked.push(id)}>{everyWay()}</CanvasOpenerProvider>
      <Where />
    </MemoryRouter>
  );
  click(host.querySelector(`button[aria-label="Open canvas: Release report"]`));
  click(host.querySelector(`a[href="/canvas/${B}?page=2"]`));
  click(host.querySelector(`a[href="/canvas/${C}"]`));
  click(host.querySelector(`[data-slot="plan-note"] a[href="/canvas/${D}"]`));
  click(host.querySelector(`[data-slot="canvas-row"] button[aria-label="Open report: Drill report"]`));
  expect(asked).toEqual([A, B, C, D, E]);
  expect(at!.pathname).toBe(HERE);
});
