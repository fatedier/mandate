import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { act } from "react";
import { ChatMessageList } from "../../src/client/routes/window/chat/ChatMessageList.js";
import { newThreadState, useAgentChatStore, type AgentMessage, type ThreadState } from "../../src/client/store/agent-chat.js";
import type { AgentPendingMonitorDto } from "../../src/shared/api/agents.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";
import { onCleanup } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../fake-phone-width.js";

// The waiting line: an agent that ended its turn on a monitor
// still waits on it. While no turn runs, the transcript ends with what it
// waits on, and that monitor's row reads in the present.

// The deadline reads as a clock on the day itself: pin the day.
beforeEach(() => { setSystemTime(new Date("2026-10-08T12:52:00.000Z")); });
afterEach(() => {
  runCleanups();
  setSystemTime();
  useAgentChatStore.setState({ threadsByScope: new Map(), messageStreams: new Map() });
});

const at = "2026-10-08T12:50:00.000Z";
const row = (seq: number, m: Partial<AgentMessage> & Pick<AgentMessage, "role" | "content">): AgentMessage => ({
  id: `m${seq}`, threadId: "t1", seq, source: "self", sourceThreadId: null, wakeId: "w1", createdAt: at, ...m
} as AgentMessage);

// A Codex pane opened by name, then watched.
const messages: AgentMessage[] = [
  row(1, { role: "user", source: "user", wakeId: null, content: { type: "text", text: "Review PR 48" } }),
  row(2, { role: "assistant", content: { type: "assistant", text: "", toolCalls: [
    { toolCallId: "c1", toolName: "spawn_pane", args: { name: "Codex PR48" } },
    { toolCallId: "c2", toolName: "monitor", args: { pane: { paneId: "%103", quietFor: "45s" }, note: "read the review" } }
  ] } }),
  row(3, { role: "tool", content: { type: "tool_result", toolCallId: "c1", toolName: "spawn_pane", result: { paneId: "%103" } } }),
  row(4, { role: "tool", content: { type: "tool_result", toolCallId: "c2", toolName: "monitor", result: { status: "registered", kind: "pane", monitorId: "ww_1", quietFor: "45s", timeoutAt: "2026-10-08T13:21:00.000Z" } } }),
  row(5, { role: "assistant", content: { type: "assistant", text: "Codex is reviewing; I will read it when it settles." } })
];
const WATCH: AgentPendingMonitorDto = {
  kind: "pane", id: "ww_1", windowKey: "md-project-1:pr_48", paneId: "%103", stableMs: 45_000,
  timeoutAt: "2026-10-08T13:21:00.000Z", note: "PR48 build log; read the output once it settles", createdAt: "2026-10-08T12:51:00.000Z"
};

const thread = (patch: Partial<ThreadState>): ThreadState =>
  ({ ...newThreadState(), threadId: "t1", loaded: true, messages, oldestSeqLoaded: 1, ...patch });

async function render(state: ThreadState) {
  const { host } = await mountAsync(<ChatMessageList thread={state} onLoadOlder={async () => {}} onRetryFailed={() => {}} />);
  await settle();
  return host;
}

const waiting = (host: HTMLElement) => [...host.querySelectorAll('[data-slot="waiting-line"]')].map((line) => line.textContent);

test("an agent waiting on a watch: the transcript ends with what it watches, when it wakes and its note", async () => {
  const host = await render(thread({ monitors: [WATCH] }));
  const lines = waiting(host);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Watching Codex PR48");
  expect(lines[0]).toContain("wakes after 45s of quiet · until 13:21");
  expect(lines[0]).toContain("PR48 build log; read the output once it settles");
  // Last in the transcript.
  const column = host.querySelector('[data-slot="transcript-column"]')!;
  expect(column.lastElementChild!.matches('[data-slot="waiting"]')).toBe(true);
});

test("while a turn runs there is no waiting line; with nothing pending there is none either", async () => {
  expect(waiting(await render(thread({ monitors: [WATCH], wakePhase: { wakeId: "w2", phase: "thinking", startedAt: at } })))).toEqual([]);
  runCleanups();
  expect(waiting(await render(thread({ monitors: [WATCH], streamingAssistant: { wakeId: "w2", totalText: "Reading" } })))).toEqual([]);
  runCleanups();
  expect(waiting(await render(thread({ monitors: [] })))).toEqual([]);
});

test("the monitor's row reads in the present while the thread waits on it, in the past once it ended", async () => {
  const rowText = async (state: ThreadState) => {
    const host = await render(state);
    const group = [...host.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Used 1 tool"))!;
    await act(async () => { group.click(); });
    // The monitor's row: its lead and what it names.
    const phrases = [...host.querySelectorAll('[data-slot="tool-phrase"]')]
      .map((phrase) => [phrase.querySelector('[data-slot="tool-lead"]')?.textContent, phrase.querySelector('[data-slot="tool-detail"]')?.textContent]);
    runCleanups();
    return phrases.filter(([lead]) => lead?.startsWith("Watch"));
  };
  expect(await rowText(thread({ monitors: [WATCH] }))).toEqual([["Watching", "Codex PR48"]]);
  expect(await rowText(thread({ monitors: [] }))).toEqual([["Watched", "Codex PR48"]]);
});

test("an agent waiting on its alarm: the line says when it wakes, with its note, and nothing after the time", async () => {
  const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: "2026-10-08T13:30:00.000Z", note: "check the deploy", createdAt: "2026-10-08T12:51:00.000Z" };
  const host = await render(thread({ monitors: [alarm] }));
  expect(waiting(host)).toEqual(["Wakes at 13:30check the deploy"]);
});

// Two or more waits are one line: the latest pane (else command) it waits on,
// how many more, and the next alarm; opened, a row each.
test("several waits fold into one line that opens to a row each: name, note, and when it wakes", async () => {
  const command: AgentPendingMonitorDto = {
    kind: "command", id: "mon_1", command: "gh pr checks 48", description: "project-1 CI on PR 48", everyMs: 300_000,
    wakeWhen: "succeeds", timeoutAt: "2026-10-08T14:00:00.000Z", note: "report the CI result", createdAt: "2026-10-08T12:40:00.000Z",
    runCount: 0, lastRunAt: null, nextRunAt: "2026-10-08T12:45:00.000Z", recentRuns: []
  };
  const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: "2026-10-08T13:30:00.000Z", note: "check the deploy", createdAt: "2026-10-08T12:30:00.000Z" };
  const host = await render(thread({ monitors: [alarm, command, WATCH] }));
  const fold = host.querySelector<HTMLButtonElement>('[data-slot="waiting-fold"]')!;
  expect(waiting(host)).toEqual([]);
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(fold.textContent).toBe("Watching Codex PR48 · 2 more · next wake 13:30");
  expect(host.querySelector('[data-slot="waiting-fold-note"]')!.textContent).toBe("PR48 build log; read the output once it settles");
  const rows = () => [...host.querySelectorAll('[data-slot="waiting-row"]')]
    .map((row) => [...row.querySelectorAll("[data-part]")].map((part) => `${part.getAttribute("data-part")}=${part.textContent}`));
  expect(rows()).toEqual([]);

  await act(async () => { fold.click(); });
  expect(fold.getAttribute("aria-expanded")).toBe("true");
  expect(fold.textContent).toBe("Waiting on 3");
  expect(host.querySelector('[data-slot="waiting-fold-note"]') === null).toBe(true);
  expect(rows()).toEqual([
    ["name=Codex PR48", "note=PR48 build log; read the output once it settles", "brief=45s quiet · until 13:21"],
    ["name=project-1 CI on PR 48", "note=report the CI result", "brief=every 5m · until 14:00"],
    ["name=13:30", "note=check the deploy"]
  ]);
  expect(document.getElementById(fold.getAttribute("aria-controls")!)!.querySelectorAll('[data-slot="waiting-row"]')).toHaveLength(3);
  // Still last in the transcript.
  const column = host.querySelector('[data-slot="transcript-column"]')!;
  expect(column.lastElementChild!.matches('[data-slot="waiting"]')).toBe(true);

  await act(async () => { fold.click(); });
  expect(fold.getAttribute("aria-expanded")).toBe("false");
  expect(rows()).toEqual([]);
});

test("only alarms fold behind the earliest, with no next wake beside it", async () => {
  const alarm = (id: string, fireAt: string, note: string): AgentPendingMonitorDto => ({ kind: "alarm", id, fireAt, note, createdAt: "2026-10-08T12:30:00.000Z" });
  const host = await render(thread({ monitors: [alarm("alm_2", "2026-10-08T16:30:00.000Z", "the release window"), alarm("alm_1", "2026-10-08T13:30:00.000Z", "check the deploy")] }));
  expect(host.querySelector('[data-slot="waiting-fold"]')!.textContent).toBe("Wakes at 13:30 · 1 more");
  expect(host.querySelector('[data-slot="waiting-fold-note"]')!.textContent).toBe("check the deploy");
});

// The card behind a command monitor's line: how many times it ran, the last
// and next run, its last five runs and its command. The same card the cause
// lines open; a pane watch or an alarm has none.
const RUNNING: AgentPendingMonitorDto = {
  kind: "command", id: "mon_1", command: "glab ci status --branch fix/evict-order | tail -1", description: "CI pipeline for MR !12", everyMs: 120_000,
  wakeWhen: "succeeds", timeoutAt: "2026-10-08T19:57:00.000Z", note: "When it passes, merge MR !12 and tell the user.", createdAt: "2026-10-08T12:00:00.000Z",
  runCount: 23, lastRunAt: "2026-10-08T12:50:00.000Z", nextRunAt: "2026-10-08T12:52:30.000Z",
  recentRuns: [
    { at: "2026-10-08T12:50:00.000Z", exitCode: 1, timedOut: false, changed: false, line: "pipeline 34 running · stage 4/5" },
    { at: "2026-10-08T12:48:00.000Z", exitCode: 1, timedOut: false, changed: false, line: "pipeline 34 running · stage 3/5" }
  ]
};
const card = () => document.querySelector<HTMLElement>('[data-slot="cause-details"]');

test("a command monitor's waiting line opens its card: runs counted, last and next, the recent runs, the command", async () => {
  const host = await render(thread({ monitors: [RUNNING] }));
  const trigger = host.querySelector<HTMLButtonElement>('[data-slot="waiting-line"] [data-slot="cause-details-trigger"]')!;
  expect(trigger.textContent).toContain("Monitoring CI pipeline for MR !12");
  expect(card()).toBe(null);
  await act(async () => { trigger.click(); });
  const shown = card()!;
  expect(shown.querySelector('[data-slot="cause-details-title"]')!.textContent).toBe("CI pipeline for MR !12");
  expect(shown.querySelector('[data-slot="cause-details-meta"]')!.textContent).toBe("Ran 23 times · last 12:50 · next 12:52 · every 2m · until 19:57");
  expect(shown.querySelector('[data-slot="cause-details-note"]')!.textContent).toBe("When it passes, merge MR !12 and tell the user.");
  const runs = [...shown.querySelectorAll('[data-slot="cause-details-run"]')].map((row) => [...row.children].map((cell) => cell.textContent));
  expect(runs).toEqual([["12:50", "exit 1", "pipeline 34 running · stage 4/5"], ["12:48", "exit 1", "pipeline 34 running · stage 3/5"]]);
  expect(shown.querySelector('[data-slot="cause-details-runs-earlier"]')!.textContent).toBe("21 earlier runs");
  expect([...shown.querySelectorAll('[data-slot="cause-details-block-label"]')].map((label) => label.textContent)).toEqual(["Command"]);
});

test("in the opened list a command's row opens its card too; a pane's and an alarm's do not", async () => {
  const alarm: AgentPendingMonitorDto = { kind: "alarm", id: "alm_1", fireAt: "2026-10-08T13:30:00.000Z", note: "check the deploy", createdAt: "2026-10-08T12:30:00.000Z" };
  const host = await render(thread({ monitors: [alarm, RUNNING, WATCH] }));
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="waiting-fold"]')!.click(); });
  const rows = [...host.querySelectorAll('[data-slot="waiting-row"]')];
  expect(rows.map((row) => row.querySelector('[data-slot="cause-details-trigger"]') !== null)).toEqual([false, true, false]);
  await act(async () => { rows[1]!.querySelector<HTMLButtonElement>('[data-slot="cause-details-trigger"]')!.click(); });
  expect(card()!.querySelector('[data-slot="cause-details-meta"]')!.textContent).toContain("Ran 23 times");
});

test("on a phone the line opens the card as a sheet", async () => {
  onCleanup(fakePhoneWidth());
  const host = await render(thread({ monitors: [RUNNING] }));
  await act(async () => { host.querySelector<HTMLButtonElement>('[data-slot="cause-details-trigger"]')!.click(); });
  expect(card()!.querySelector('[data-slot="bottom-sheet-body"]')!.textContent).toContain("21 earlier runs");
});
