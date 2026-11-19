import { afterEach, expect, test } from "bun:test";
import { TERMINAL_TABS_STORAGE_KEY, useTerminalTabsStore } from "@/store/terminal-tabs";

// The Terminals page's open tabs (this browser), dragged into another order.
afterEach(() => { useTerminalTabsStore.setState({ open: [] }); localStorage.removeItem(TERMINAL_TABS_STORAGE_KEY); });

const open = (...ids: string[]) => ids.map((id, i) => ({ paneId: id, pid: 100 + i }));
const ids = () => useTerminalTabsStore.getState().open.map((t) => t.paneId);

test("move puts an open tab at the other's place, either way", () => {
  useTerminalTabsStore.setState({ open: open("%x", "%y", "%z") });
  useTerminalTabsStore.getState().move("%x", 100, "%z", 102);
  expect(ids()).toEqual(["%y", "%z", "%x"]);
  useTerminalTabsStore.setState({ open: open("%x", "%y", "%z") });
  useTerminalTabsStore.getState().move("%z", 102, "%y", 101);
  expect(ids()).toEqual(["%x", "%z", "%y"]);
});

test("the moved order is kept in this browser", () => {
  useTerminalTabsStore.setState({ open: open("%x", "%y") });
  useTerminalTabsStore.getState().move("%x", 100, "%y", 101);
  expect(JSON.parse(localStorage.getItem(TERMINAL_TABS_STORAGE_KEY)!).state.open.map((t: { paneId: string }) => t.paneId)).toEqual(["%y", "%x"]);
});

test("a move naming a tab not open, or a pid that is not its pane's, writes nothing", () => {
  useTerminalTabsStore.setState({ open: open("%x", "%y") });
  localStorage.removeItem(TERMINAL_TABS_STORAGE_KEY);
  useTerminalTabsStore.getState().move("%x", 100, "%q", 9);
  useTerminalTabsStore.getState().move("%x", 999, "%y", 101);
  useTerminalTabsStore.getState().move("%x", 100, "%x", 100);
  expect(ids()).toEqual(["%x", "%y"]);
  expect(localStorage.getItem(TERMINAL_TABS_STORAGE_KEY)).toBeNull();
});
