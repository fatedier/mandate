import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { AgentPagePane } from "@/routes/personal/page/AgentPagePane";
import { resetAgentPageStore } from "@/store/agent-page";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useThreadTabsStore } from "@/store/thread-tabs";
import { useClosedTabsStore } from "@/store/closed-tabs";
import { CALENDAR_TAB, NOTES_TAB } from "@/lib/panel-tabs";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settleUntil } from "../helpers/mount.js";
import { resetStickyNotesStore } from "../helpers/sticky-notes.js";

// The calendar beside the personal agent: a Calendar tab in its panel, opened
// from +, the view the Calendar page draws.

const UI = { open: true, maximized: false, ratio: 0.5, narrow: false, narrowView: "chat" as const, tabs: [], active: "page", fileLines: {}, history: false, recent: [], tasksView: { query: "", showCancelled: false } };
afterEach(() => {
  runCleanups();
  resetAgentPageStore();
  resetStickyNotesStore();
  useThreadTabsStore.setState({ tabs: null, latest: 0, applied: 0 });
  useAgentPageUi.setState(UI);
  useClosedTabsStore.setState({ byPanel: {} });
  try { window.localStorage.removeItem("mandate.calendar.view.panel"); } catch { /* none */ }
});

function serve() {
  return mockFetch((call) => {
    const path = new URL(call.url, "http://x").pathname;
    if (path === "/api/agent-page") return jsonResponse({ latest: null, write: null });
    if (path === "/api/agents/personal/thread-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agents/threads/thr_g/reply-tabs") return jsonResponse({ tabs: [] });
    if (path === "/api/agent-page/sources") return jsonResponse({ sources: [] });
    if (path === "/api/calendar") return jsonResponse({ entries: [], times: [], from: 0, to: 0 });
    return jsonResponse({}, 404);
  });
}

const calendarTab = (host: ParentNode) => host.querySelector<HTMLElement>('[data-calendar-tab][role="tab"]');

async function openAddMenu(host: HTMLElement) {
  await act(async () => {
    host.querySelector<HTMLElement>('[aria-label="Open a thread beside Juno"]')!.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    await new Promise((r) => setTimeout(r, 0));
  });
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

test("+ opens a Calendar tab after Notes; it draws the calendar and closes like a thread tab", async () => {
  serve();
  act(() => { useAgentPageUi.getState().openNotes(); useAgentPageUi.getState().setActive("page"); });
  const host = (await mountAsync(<AgentPagePane name="Juno" threadId="thr_g" />, { path: "/agent" })).host;
  const items = await openAddMenu(host);
  expect(items.slice(0, 3).map((i) => i.textContent?.trim())).toEqual(["Tasks", "Notes", "Calendar"]);
  await act(async () => { items[2]!.click(); });
  expect([calendarTab(host)?.getAttribute("aria-selected"), useAgentPageUi.getState().active]).toEqual(["true", CALENDAR_TAB]);
  expect(useAgentPageUi.getState().tabs.slice(0, 2)).toEqual([NOTES_TAB, CALENDAR_TAB]);
  await settleUntil(() => host.querySelector('[data-slot="calendar-view"][data-place="panel"]') !== null, "the calendar drawn in the panel");
  expect(host.querySelector('[data-slot="calendar-view"]')?.getAttribute("data-view")).toBe("week");
  await act(async () => { calendarTab(host)!.querySelector<HTMLElement>('[aria-label="Close Calendar"]')!.click(); });
  expect([calendarTab(host) === null, useAgentPageUi.getState().active]).toEqual([true, "page"]);
});

test("the Calendar tab, opened first, leads the row; it is kept across a reload", async () => {
  serve();
  act(() => { useAgentPageUi.getState().openCalendar(); });
  expect([useAgentPageUi.getState().tabs, useAgentPageUi.getState().active]).toEqual([[CALENDAR_TAB], CALENDAR_TAB]);
  // What a reload reads back: the saved tabs pass the whitelist.
  const merged = useAgentPageUi.persist.getOptions().merge!({ tabs: [CALENDAR_TAB, "nonsense"], open: true }, useAgentPageUi.getState()) as { tabs: string[] };
  expect(merged.tabs).toEqual([CALENDAR_TAB]);
});
