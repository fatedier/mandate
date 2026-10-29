import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { badgeValue } from "@/lib/dock-badge";
import { DockBadge } from "@/shell/DockBadge";
import { useThreadStatusStore } from "@/store/thread-status";
import { useGlobalAgentStore } from "@/store/global-agent";
import type { WaitingEntryDto } from "@shared/api/thread-status";
import { runCleanups } from "../helpers/cleanup.js";
import { mount } from "../helpers/mount.js";

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

afterEach(() => {
  // Unmount before the stores the badge reads are reset under it.
  runCleanups();
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [] }));
  delete (window as TauriWindow).__TAURI_INTERNALS__;
});

function render(set: (count: number | undefined) => void) {
  mount(<DockBadge set={set} />);
}

test("badgeValue: positive counts pass through, zero and junk clear the badge", () => {
  expect(badgeValue(3)).toBe(3);
  expect(badgeValue(2.7)).toBe(2);
  expect(badgeValue(0)).toBe(undefined);
  expect(badgeValue(-1)).toBe(undefined);
  expect(badgeValue(Number.NaN)).toBe(undefined);
});

test("browser: never touches the badge", () => {
  const calls: Array<number | undefined> = [];
  render((c) => { calls.push(c); });
  expect(calls).toStrictEqual([]);
});

test("desktop: the badge follows the server's list, Your agent's own question counted too, and clears when it empties", () => {
  (window as TauriWindow).__TAURI_INTERNALS__ = {};
  const calls: Array<number | undefined> = [];
  render((c) => { calls.push(c); });
  const failed: WaitingEntryDto = { key: "thread:t1:failed", kind: "thread", waiting: "failed", threadId: "t1", threadTitle: "Cache work", featureId: null, workerName: null, text: "boom", place: null };
  const agentAsks: WaitingEntryDto = { key: "agent:agent:input", kind: "agent", waiting: "input", threadId: null, threadTitle: null, featureId: null, workerName: null, text: "Now?", place: null };
  act(() => useGlobalAgentStore.setState({ agent: { threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: false, lastVisibleSeq: 0, questions: [] } }));
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [failed, agentAsks] }));
  expect(calls.at(-1)).toBe(2);
  act(() => useThreadStatusStore.getState().replace({ threads: [], waiting: [] }));
  expect(calls.at(-1)).toBe(undefined);
  act(() => useGlobalAgentStore.setState({ agent: null }));
  // Cleared on mount, when the server listed nothing yet; once per change
  // after. Strict: toEqual takes a missing trailing undefined as equal.
  expect(calls).toStrictEqual([undefined, 2, undefined]);
});
