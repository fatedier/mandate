import { afterEach, expect, test } from "bun:test";
import { canvasIdOfTab, canvasTabId } from "@/lib/panel-tabs";
import { useWorkerPanelStore } from "@/store/worker-panel";
import { useAgentPageUi } from "@/store/agent-page-ui";

// The right panel's tabs: a thread's (Workers first, then workers and
// canvases) and Your agent's (Page first, then canvases). A canvas is a tab
// as a worker is, remembered with it.

afterEach(() => {
  localStorage.removeItem("mandate.worker-panel.v1");
  localStorage.removeItem("mandate.agent-page.v1");
  useWorkerPanelStore.setState({ byThread: {}, maximized: null, narrow: false, narrowView: "chat" });
  useAgentPageUi.setState({ open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat", tabs: [], active: "page" });
});

test("canvasIdOfTab reads only canvas tabs", () => {
  expect(canvasTabId("cnv_x")).toBe("canvas:cnv_x");
  expect([canvasIdOfTab("canvas:cnv_x"), canvasIdOfTab("w1"), canvasIdOfTab("archived:w1")]).toEqual(["cnv_x", null, null]);
});

test("a canvas opens as a tab once, at the end, and becomes the open one", () => {
  const panel = useWorkerPanelStore.getState();
  panel.openWorker("thr_a", "w1");
  panel.setOpen("thr_a", false);
  panel.openCanvas("thr_a", "cnv_r");
  panel.setActive("thr_a", "w1");
  panel.openCanvas("thr_a", "cnv_r");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ open: true, tabs: ["w1", "canvas:cnv_r"], active: "canvas:cnv_r" });
  expect(useWorkerPanelStore.getState().narrowView).toBe("panel");

  const agent = useAgentPageUi.getState();
  agent.setOpen(false);
  agent.setNarrow(true);
  agent.openCanvas("cnv_r");
  agent.setActive("page");
  agent.openCanvas("cnv_r");
  expect(useAgentPageUi.getState()).toMatchObject({ open: true, tabs: ["canvas:cnv_r"], active: "canvas:cnv_r", narrowView: "side" });
});

test("closing the open tab opens its left neighbour (the next one for the first), the first tab when none is left", () => {
  const panel = useWorkerPanelStore.getState();
  panel.openWorker("thr_a", "w1");
  panel.openCanvas("thr_a", "cnv_r");
  panel.openCanvas("thr_a", "cnv_d");
  panel.setActive("thr_a", "canvas:cnv_r");
  panel.closeTab("thr_a", "canvas:cnv_r");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_d"], active: "w1" });
  panel.closeTab("thr_a", "w1");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["canvas:cnv_d"], active: "canvas:cnv_d" });
  panel.closeTab("thr_a", "canvas:cnv_d");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: [], active: "workers" });

  const agent = useAgentPageUi.getState();
  agent.openCanvas("cnv_r");
  agent.openCanvas("cnv_d");
  agent.closeTab("canvas:cnv_d");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_r"], active: "canvas:cnv_r" });
  agent.closeTab("canvas:cnv_r");
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: [], active: "page" });
});

test("state saved before canvas tabs loads as it was", async () => {
  localStorage.setItem("mandate.worker-panel.v1", JSON.stringify({
    state: { byThread: { thr_a: { open: true, tabs: ["w1", "archived:old"], active: "archived:old", workerTab: { w1: "plan" } } } },
    version: 0
  }));
  await useWorkerPanelStore.persist.rehydrate();
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ open: true, tabs: ["w1", "archived:old"], active: "archived:old", workerTab: { w1: "plan" } });

  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: false, maximized: false, ratio: 0.4 }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState()).toMatchObject({ open: false, ratio: 0.4, tabs: [], active: "page" });
});

test("Your agent's tabs are remembered, and saved ones that are not tab ids are dropped", async () => {
  useAgentPageUi.getState().openCanvas("cnv_r");
  const saved = JSON.parse(localStorage.getItem("mandate.agent-page.v1") ?? "{}") as { state: Record<string, unknown> };
  expect(saved.state).toMatchObject({ tabs: ["canvas:cnv_r"], active: "canvas:cnv_r" });

  localStorage.setItem("mandate.agent-page.v1", JSON.stringify({ state: { open: true, ratio: 0.5, tabs: ["canvas:cnv_a", 3, null], active: "canvas:cnv_gone" }, version: 0 }));
  await useAgentPageUi.persist.rehydrate();
  expect(useAgentPageUi.getState()).toMatchObject({ tabs: ["canvas:cnv_a"], active: "page" });
});

// A row that shows only some of the tabs (the phone's sheet shows no canvas
// tabs) closes its open tab onto a neighbour it shows; the rule reads the
// tabs as they are when the close happens, so a close that lands late (a
// delete answered after another tab was chosen) leaves the open tab alone.
test("closing among the tabs a row shows opens a neighbour it shows; a late close of a tab not open changes nothing", () => {
  const panel = useWorkerPanelStore.getState();
  useWorkerPanelStore.setState({ byThread: { thr_a: { open: true, tabs: ["w1", "canvas:cnv_x", "w2"], active: "w2", workerTab: {} } } });
  panel.closeTab("thr_a", "w2", (id) => canvasIdOfTab(id) === null);
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_x"], active: "w1" });
  panel.openCanvas("thr_a", "cnv_y");
  panel.closeTab("thr_a", "canvas:cnv_x");
  expect(useWorkerPanelStore.getState().get("thr_a")).toMatchObject({ tabs: ["w1", "canvas:cnv_y"], active: "canvas:cnv_y" });
});
