import { afterEach, expect, jest, test } from "bun:test";
import { act } from "react";
import { MemoryRouter } from "react-router";
import { ProjectsPage } from "@/routes/projects/ProjectsPage";
import { PaneHeaderActionsSlot, PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { useProjectsStore } from "@/store/projects";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync } from "../helpers/mount.js";
import { realClock } from "../helpers/fake-clock.js";

afterEach(() => {
  // Unmount before the store the page reads is reset under it.
  runCleanups();
  act(() => useProjectsStore.getState().setProjectsState([]));
});

async function render() {
  const { host } = await mountAsync(
    <MemoryRouter>
      <PaneHeaderSlotsProvider>
        <PaneHeaderActionsSlot />
        <ProjectsPage />
      </PaneHeaderSlotsProvider>
    </MemoryRouter>
  );
  return host;
}

test("before the projects arrive the page says Loading…, never \"No projects yet\"", async () => {
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useProjectsStore.setState({ loaded: false });
  });
  const host = await render();
  expect(host.querySelector('[data-slot="loading-line"]')!.textContent).toBe("Loading…");
  expect(host.textContent).not.toContain("No projects yet");
  // They arrive, and there are none: now it can say so.
  act(() => useProjectsStore.getState().setProjectsState([]));
  expect(host.textContent).toContain("No projects yet");
  expect(host.querySelector('[data-slot="loading-line"]') === null).toBe(true);
});

test("projects that never arrive are said so after a while, with Retry", async () => {
  act(() => {
    useProjectsStore.getState().setProjectsState([]);
    useProjectsStore.setState({ loaded: false });
  });
  jest.useFakeTimers();
  try {
    const host = await render();
    act(() => { jest.advanceTimersByTime(9_000); });
    expect(host.textContent).toContain("Loading…");
    act(() => { jest.advanceTimersByTime(1_000); });
    expect(host.querySelector('[data-slot="state-message"] h1')?.textContent).toBe("Couldn't load projects");
    expect([...host.querySelectorAll('[data-slot="state-message"] button')].map((b) => b.textContent)).toEqual(["Retry"]);
    expect(host.textContent).not.toContain("No projects yet");
  } finally {
    realClock();
  }
});
