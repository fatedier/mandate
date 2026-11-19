import { act } from "react";
import { afterEach, expect, test } from "bun:test";
import { mount } from "../helpers/mount.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../helpers/fake-phone-width.js";
import { stub } from "../helpers/typed.js";
import type { AgentMessage } from "@/store/agent-chat";
import { causeForTriggerMessage, provenanceForWake } from "@/routes/window/chat/chatProvenance";
import { ChatProvenanceLine } from "@/routes/window/chat/ChatProvenanceLine";
import { formatCalendarDate, formatClockMinutes } from "@/lib/format";
import { threadNoticeMetadata } from "@shared/thread-notice";
import { renderPaneMonitorMessage, type PaneTail, type StoredPaneMonitor, type PaneMonitorTriggerReason } from "../../src/server/modules/agent/pane-monitor-manager.js";
import { renderCommandMonitorMessage } from "../../src/server/modules/agent/command-monitor-manager.js";
import { renderAlarmMessage } from "../../src/server/modules/agent/agent-alarm-manager.js";
import { dutyEmptyReply, joinPendingWakes, renderScheduleWake, scheduleNotes } from "../../src/server/modules/schedules/schedule-messages.js";

afterEach(() => { runCleanups(); });

// A cause line opens what is behind it: how it fired, the agent's note
// whole, the pane's last lines or the command's output and errors. Not the
// message the model read: no ids, no words for the model. The events are
// the server's own renderings, so the card reads what the server writes.

const AT = "2026-10-27T07:04:00.000Z";
const message = (source: string, text: string, createdAt = AT, metadata?: Record<string, unknown>): AgentMessage => ({
  id: "m1", seq: 1, threadId: "thr_m", role: "user", source, sourceThreadId: null, wakeId: null,
  wakeReason: null, wakeMetadata: null, wakeStartedAt: null, createdAt,
  content: { type: "text", text, ...(metadata ? { metadata } : {}) }
} as unknown as AgentMessage);

const PANE_NOTE = "The review of the notes. When it settles, read its verdict and send the notes on if nothing blocks.";
const watch = stub<StoredPaneMonitor>({ id: "mon_pane_preview01", windowKey: "md-notes:release-notes", paneId: "%42", paneName: "Review", stableMs: 30_000, note: PANE_NOTE });
const paneEvent = (reason: PaneMonitorTriggerReason = "settled", tail: PaneTail | null = { status: "captured", text: "  def check():\n      return ready\nVerdict: one fix needed." }) =>
  message("pane-monitor", renderPaneMonitorMessage(watch, reason, tail));

type MonitorRow = Parameters<typeof renderCommandMonitorMessage>[0];
const monitorRow: MonitorRow = { id: "mon_preview01", command: "bun scripts/check-links.ts docs/notes.md", every_ms: 120_000, wake_when: "succeeds", note: "Once the links pass, send the notes for a final read.", description: "Link check on the notes" };
const commandEvent = (result: Parameters<typeof renderCommandMonitorMessage>[1], detail: Parameters<typeof renderCommandMonitorMessage>[2], row: Partial<MonitorRow> = {}) =>
  message("command-monitor", renderCommandMonitorMessage({ ...monitorRow, ...row }, result, detail));

const ALARM_NOTE = "Check the notes worker: the draft should be in by now.\nIf it is, start a fresh review; if not, ask what is blocking it.";
const alarmEvent = (fireAt: string, rangAt: string, note = ALARM_NOTE) => message("alarm", renderAlarmMessage({
  id: "alm_preview01", thread_id: "thr_m", fire_at: fireAt, note, status: "fired", created_at: "2026-10-27T05:00:00.000Z", fired_at: rangAt
}, "Asia/Singapore"), rangAt);

const lineOf = (m: AgentMessage) => mount(<ChatProvenanceLine provenance={causeForTriggerMessage(m, () => null)!} />, { path: "/threads/thr_m" });
const card = () => document.querySelector<HTMLElement>('[data-slot="cause-details"]');
const trigger = (host: HTMLElement) => host.querySelector<HTMLElement>('[data-slot="cause-details-trigger"]')!;
const open = (host: HTMLElement) => act(() => { trigger(host).click(); });
const part = (slot: string) => card()?.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;
const blocks = () => [...card()!.querySelectorAll('[data-slot="cause-details-block"]')].map((b) => [
  b.querySelector('[data-slot="cause-details-block-label"]')!.textContent,
  b.querySelector("pre")!.textContent
]);
const MODEL_WORDS = ["mon_pane_preview01", "mon_preview01", "alm_preview01", "%42", "md-notes", "windowKey", "action", "untrusted", "| "];

test("a pane monitor's line opens how the pane settled, the agent's note whole and the pane's last lines as they came, with nothing meant for the model", () => {
  const { host } = lineOf(paneEvent());
  expect(card() === null).toBe(true);
  open(host);
  expect(part("cause-details-title")).toBe("Review went quiet for 30s");
  expect(part("cause-details-meta")).toBe("Unchanged for 30s");
  expect(part("cause-details-note")).toBe(PANE_NOTE);
  // Indentation is the output's own.
  expect(blocks()).toEqual([["Last lines of the pane", "  def check():\n      return ready\nVerdict: one fix needed."]]);
  for (const raw of MODEL_WORDS) expect(card()!.textContent).not.toContain(raw);
});

test("a pane that timed out or closed says so; a tail that could not be read is no block", () => {
  for (const [reason, meta] of [["timeout", "Timed out"], ["target_missing", "The pane closed"]] as const) {
    const { host } = lineOf(paneEvent(reason, { status: "unavailable" }));
    open(host);
    expect([reason, part("cause-details-meta"), blocks()]).toEqual([reason, meta, []]);
    runCleanups();
  }
});

test("a command monitor's card says how often it ran and what it waited for, then the command and its output; a run that succeeded names no exit code it does not carry", () => {
  const { host } = lineOf(commandEvent("succeeded", { output: "checked 37 links\nall reachable" }));
  open(host);
  expect(part("cause-details-title")).toBe("Link check on the notes · succeeded");
  expect(part("cause-details-meta")).toBe("Every 2m · Wakes when it succeeds");
  expect(part("cause-details-note")).toBe("Once the links pass, send the notes for a final read.");
  expect(blocks()).toEqual([["Command", "bun scripts/check-links.ts docs/notes.md"], ["Output", "checked 37 links\nall reachable"]]);
  for (const raw of MODEL_WORDS) expect(card()!.textContent).not.toContain(raw);
});

test("a command that changed shows what changed and its output now", () => {
  const { host } = lineOf(commandEvent("changed", { previous: "a\nb", output: "a\nc" }, { wake_when: "changed" }));
  open(host);
  expect(part("cause-details-meta")).toBe("Every 2m · Wakes when it changes");
  expect(blocks()).toEqual([["Command", "bun scripts/check-links.ts docs/notes.md"], ["Changes", "- b\n+ c"], ["Output", "a\nc"]]);
});

test("a command that kept failing shows its last error; one that timed out its exit code, output and error output", () => {
  const failing = lineOf(commandEvent("failing", { error: "exit code 2\nlink checker: config missing" }));
  open(failing.host);
  expect(part("cause-details-title")).toBe("Link check on the notes · failed 5 runs in a row");
  expect(blocks()).toEqual([["Command", "bun scripts/check-links.ts docs/notes.md"], ["Last error", "exit code 2\nlink checker: config missing"]]);
  runCleanups();
  const timedOut = lineOf(commandEvent("timeout", { exitCode: 1, output: "checked 12 links", stderr: "warning: slow host" }));
  open(timedOut.host);
  expect(part("cause-details-meta")).toBe("Every 2m · Wakes when it succeeds · Exit code 1");
  expect(blocks()).toEqual([["Command", "bun scripts/check-links.ts docs/notes.md"], ["Output", "checked 12 links"], ["Error output", "warning: slow host"]]);
});

test("a command without a description is the card's title, and whole in a block too (the title is cut); an empty output is no block", () => {
  const { host } = lineOf(commandEvent("succeeded", { output: "" }, { description: null }));
  open(host);
  expect(part("cause-details-title")).toBe("bun scripts/check-links.ts docs/notes.md · succeeded");
  expect(card()!.querySelector('[data-slot="cause-details-title"] code')?.textContent).toBe("bun scripts/check-links.ts docs/notes.md");
  expect(blocks()).toEqual([["Command", "bun scripts/check-links.ts docs/notes.md"]]);
});

test("output that reads \"unavailable\" is output; only a pane the server could not read has no block", () => {
  const command = lineOf(commandEvent("succeeded", { output: "unavailable" }));
  open(command.host);
  expect(blocks()).toEqual([["Command", "bun scripts/check-links.ts docs/notes.md"], ["Output", "unavailable"]]);
  runCleanups();
  const pane = lineOf(paneEvent("settled", { status: "captured", text: "unavailable" }));
  open(pane.host);
  expect(blocks()).toEqual([["Last lines of the pane", "unavailable"]]);
});

test("an alarm's card gives the time it was set for and the time it rang, in the reader's clock, and its note whole", () => {
  const fireAt = "2026-10-27T07:00:00.000Z";
  const rangAt = "2026-10-27T07:04:00.000Z";
  const { host } = lineOf(alarmEvent(fireAt, rangAt));
  open(host);
  expect(part("cause-details-title")).toBe("Alarm");
  expect(part("cause-details-meta")).toBe(`Set for ${formatClockMinutes(fireAt)} · Rang ${formatClockMinutes(rangAt)}`);
  expect(part("cause-details-note")).toBe(ALARM_NOTE);
  for (const raw of MODEL_WORDS) expect(card()!.textContent).not.toContain(raw);
});

test("an alarm that rang on another day than it was set for names the days", () => {
  const fireAt = "2026-10-26T15:50:00.000Z";
  const rangAt = "2026-10-28T01:10:00.000Z";
  const { host } = lineOf(alarmEvent(fireAt, rangAt));
  open(host);
  expect(part("cause-details-meta")).toBe(`Set for ${formatCalendarDate(fireAt)} ${formatClockMinutes(fireAt)} · Rang ${formatCalendarDate(rangAt)} ${formatClockMinutes(rangAt)}`);
});

test("an alarm's note is read to its end, whatever its lines look like", () => {
  const note = "Check the seed trays.\naction: if dry, water them\noutput: the tray list\npaneTail (copied): not a section";
  const { host } = lineOf(alarmEvent("2026-10-27T07:00:00.000Z", AT, note));
  open(host);
  expect(part("cause-details-note")).toBe(note);
  expect(blocks()).toEqual([]);
});

test("an alarm's note is not read for times: one with no set-for time names only when it rang", () => {
  const old = ["[Mandate alarm fired]", "alarmId: alm_old", "note: Remind me. fired at: Mon 2026-10-26 09:00 +08:00"].join("\n");
  const { host } = lineOf(message("alarm", old));
  open(host);
  expect(part("cause-details-meta")).toBe(`Rang ${formatClockMinutes(AT)}`);
  expect(part("cause-details-note")).toBe("Remind me. fired at: Mon 2026-10-26 09:00 +08:00");
});

test("on a phone the card rises in the sheet, its body reachable by keyboard, and focus comes back to the line", () => {
  onCleanup(fakePhoneWidth());
  const { host } = lineOf(paneEvent());
  open(host);
  const sheet = card()!;
  const body = sheet.querySelector<HTMLElement>('[data-slot="bottom-sheet-body"]')!;
  expect(body.textContent).toContain(PANE_NOTE);
  // Tab reaches the body, which raises the sheet to show what is below.
  expect(body.querySelector('[data-slot="cause-details-body"]')!.getAttribute("tabindex")).toBe("0");
  act(() => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(document.activeElement === trigger(host)).toBe(true);
});

// A card is drawn elsewhere on the page, but its events still pass up the
// transcript's tree: a wheel or a touch in it must not tell the transcript
// the reader scrolled away from the latest reply.
test("a wheel or a touch in the card does not reach the transcript around the line", () => {
  for (const phone of [false, true]) {
    if (phone) onCleanup(fakePhoneWidth());
    const seen: string[] = [];
    const { host } = mount(
      <div onWheel={() => seen.push("wheel")} onTouchStart={() => seen.push("touchstart")} onTouchMove={() => seen.push("touchmove")}>
        <ChatProvenanceLine provenance={causeForTriggerMessage(paneEvent(), () => null)!} />
      </div>, { path: "/threads/thr_m" });
    open(host);
    const inside = card()!.querySelector('[data-slot="cause-details-body"]')!;
    // The page's own Event: React reads the type, not the class.
    const PageEvent = inside.ownerDocument.defaultView!.Event;
    act(() => { for (const type of ["wheel", "touchstart", "touchmove"]) inside.dispatchEvent(new PageEvent(type, { bubbles: true })); });
    expect([phone, seen]).toEqual([phone, []]);
    runCleanups();
  }
});

test("each output block takes keyboard focus, so what scrolls in it can be scrolled", () => {
  const { host } = lineOf(commandEvent("succeeded", { output: "checked 37 links" }));
  open(host);
  expect([...card()!.querySelectorAll("pre")].map((pre) => pre.getAttribute("tabindex"))).toEqual(["0", "0"]);
});

test("with a mouse the card is a box at the line, not the sheet", () => {
  const { host } = lineOf(paneEvent());
  open(host);
  expect(card()!.querySelector('[data-slot="bottom-sheet-body"]') === null).toBe(true);
  expect(card()!.getAttribute("role")).toBe("dialog");
});

test("no cause line carries the message the model read as its title", () => {
  const notice = message("thread-notice", "[Thread notice] Thread \"Search\" (thr_1): stopped.", AT, threadNoticeMetadata({
    handoffIds: [], kind: "thread", targetThreadId: "thr_1", workerId: null, title: "Search", stop: "stopped", reason: null
  }));
  for (const m of [paneEvent(), commandEvent("succeeded", { output: "ok" }), alarmEvent(AT, AT), notice]) {
    const { host } = lineOf(m);
    expect([m.source, host.querySelector("[title]")?.getAttribute("title") ?? null]).toEqual([m.source, null]);
    runCleanups();
  }
  const check = mount(<ChatProvenanceLine provenance={provenanceForWake("sweep")!} />);
  expect(check.host.querySelector("[title]") === null).toBe(true);
  // A line with nothing behind it is no button.
  expect(check.host.querySelector('[data-slot="cause-details-trigger"]') === null).toBe(true);
});

// A schedule's wake, as the server writes it (renderScheduleWake): its line
// says a scheduled check found something; the card lists what it found and
// the check's output, without the words for the model.
const scheduleWake = (over: Partial<Parameters<typeof renderScheduleWake>[0]> = {}) => renderScheduleWake({
  name: "greenhouse daily check", id: "sch_preview01", timezone: "UTC", dueAt: "2026-11-04T09:00:00.000Z", ranAt: "2026-11-04T09:00:02.000Z",
  missed: 0, message: "2 new sensor findings", context: "WARN dry soil at bed-3/row-2\n  read by sensor north-3",
  items: [{ id: "sig:qwer", title: "Dry soil in bed 3", version: null }, { id: "sig:asdf", title: "Fan 2 not answering", version: null }], ...over
});

test("a scheduled check's line says what it found; its card lists the new items and the output as they came", () => {
  const { host } = lineOf(message("schedule", scheduleWake()));
  expect(host.textContent).toContain("Scheduled check");
  expect(host.textContent).toContain("2 new sensor findings");
  open(host);
  expect(part("cause-details-title")).toBe("Scheduled check");
  expect(part("cause-details-meta")).toBe("greenhouse daily check");
  expect(blocks()).toEqual([
    ["New items", "sig:qwer  Dry soil in bed 3\nsig:asdf  Fan 2 not answering"],
    ["Output", "WARN dry soil at bed-3/row-2\n  read by sensor north-3"]
  ]);
  for (const raw of ["sch_preview01", "untrusted", "| ", "[Mandate schedule check]", "due:"]) expect([raw, card()!.textContent!.includes(raw)]).toEqual([raw, false]);
});

test("checks that ran while the thread was busy read as one card; missed due times are counted", () => {
  const joined = joinPendingWakes([
    scheduleWake({ missed: 2, items: [{ id: "sig:qwer", title: "Dry soil in bed 3", version: null }], context: "" }),
    scheduleWake({ message: "bed 5 at half its usual moisture", items: [], context: "moisture 12%" })
  ]);
  const { host } = lineOf(message("schedule", joined));
  open(host);
  expect(part("cause-details-meta")).toBe("greenhouse daily check · 2 missed, ran once");
  expect(blocks()).toEqual([["New items", "sig:qwer  Dry soil in bed 3"], ["Output", "moisture 12%"]]);
});

test("a check cut where it was read says so on its card, as the thread was told", () => {
  const cut = "[Cut: the first 3,000 of 9,876 characters. The whole text: /data/tool-output/thr_1/cut-ab12.txt]";
  const { host } = lineOf(message("schedule", scheduleWake({ fit: (body) => `${cut}\n\n${body.slice(0, 40)}` })));
  open(host);
  expect(part("cause-details-note")?.startsWith(`${cut}\n\n`)).toBe(true);
});

test("a check's message over several lines is read whole", () => {
  const { host } = lineOf(message("schedule", scheduleWake({ message: "2 new sensor findings\naffected: bed 3, bed 5" })));
  open(host);
  expect(part("cause-details-note")).toBe("2 new sensor findings\naffected: bed 3, bed 5");
  expect(blocks().map(([label]) => label)).toEqual(["New items", "Output"]);
});

test("the ask after a duty thread's empty reply reads as itself, without its mark", () => {
  const ask = dutyEmptyReply("Juno");
  const { host } = lineOf(message("schedule", ask));
  expect(host.textContent).not.toContain("Scheduled check");
  expect(host.textContent).not.toContain("[Duty]");
  open(host);
  expect(part("cause-details-note")).toBe(ask.replace(/^\[Duty\] /, ""));
});

test("a schedule's note to the personal agent reads as itself, not as a check that ran", () => {
  const note = scheduleNotes.pausedFailing("greenhouse daily check", "exit code 7");
  const { host } = lineOf(message("schedule", note));
  expect(host.textContent).not.toContain("Scheduled check");
  expect(host.textContent).toContain("\"greenhouse daily check\" is paused: its check failed 5 times in a row.");
  open(host);
  expect(part("cause-details-note")).toBe(note.replace(/^\[Schedule\] /, ""));
});
