import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { ThreadModelDto } from "../../src/shared/api-contracts.js";
import { SSE_EVENTS } from "../../src/shared/api-contracts.js";
import { ThreadModelControl } from "../../src/client/routes/window/chat/ThreadModelControl.js";
import { choiceName, modelLabel } from "../../src/client/routes/window/chat/thread-model.js";
import { useThreadModelsStore } from "../../src/client/store/thread-models.js";
import { useWakeModelStore } from "../../src/client/store/wake-models.js";
import { attachSnapshotSseListeners } from "../../src/client/lib/snapshot-sse-listeners.js";
import { fetchThreadById } from "../../src/client/store/agent-chat-api.js";
import { mount, settleUntil } from "../helpers/mount.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { fakePhoneWidth } from "../fake-phone-width.js";

// The composer's model: what the thread's turn calls now, else its pick,
// else its Default; a menu (a sheet on a phone) switches it.

const ref = (providerName: string, model: string) => ({ ref: `${providerName}/${model}`, providerName, model });
const STATE: ThreadModelDto = {
  default: ref("provider-1", "anthropic/claude-opus-5-5"),
  override: null,
  choices: [
    { providerName: "provider-1", models: [ref("provider-1", "anthropic/claude-opus-5-5"), ref("provider-1", "openai/gpt-6.1-sol")] },
    { providerName: "kilo", models: [ref("kilo", "anthropic/claude-opus-5.5"), ref("kilo", "deepseek/deepseek-v4.1-flash-1017")] }
  ]
};

afterEach(() => {
  runCleanups();
  useThreadModelsStore.setState({ byThread: new Map(), revision: new Map(), latest: new Map(), applied: new Map(), writes: new Map() });
  useWakeModelStore.setState({ byWake: new Map(), told: 0, toldAt: new Map(), reads: 0, readAt: new Map() });
});

/** The server's model route: GET answers the state, PUT the state with its pick. */
function serve(initial: ThreadModelDto = STATE) {
  let state = initial;
  const calls = mockFetch((call) => {
    if (call.method === "PUT") {
      const picked = (JSON.parse(String(call.init?.body)) as { model: string | null }).model;
      const all = state.choices.flatMap((g) => g.models);
      state = { ...state, override: picked === null ? null : all.find((m) => m.ref === picked) ?? null };
    }
    return jsonResponse({ model: state });
  });
  return calls;
}

const nameShown = (host: HTMLElement) => host.querySelector('[data-slot="thread-model-name"]')?.textContent ?? null;
const button = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('[data-slot="thread-model"]');
const puts = (calls: FetchCall[]) => calls.filter((c) => c.method === "PUT").map((c) => JSON.parse(String(c.init?.body)) as unknown);

test("the name is the model's own, with its provider when that is not the Default's; a choice is short unless its provider has two of that name", () => {
  expect(modelLabel(STATE, null)).toBe("claude-opus-5-5");
  expect(modelLabel({ ...STATE, override: ref("provider-1", "openai/gpt-6.1-sol") }, null)).toBe("gpt-6.1-sol");
  expect(modelLabel(STATE, ref("kilo", "anthropic/claude-opus-5.5"))).toBe("claude-opus-5.5 · kilo");
  expect(modelLabel({ ...STATE, override: ref("kilo", "deepseek/deepseek-v4.1-flash-1017") }, ref("provider-1", "anthropic/claude-opus-5-5"))).toBe("claude-opus-5-5");
  const twins = [ref("p", "openai/gpt-x"), ref("p", "azure/gpt-x"), ref("p", "anthropic/claude-y")];
  expect(twins.map((m) => choiceName(m, twins))).toEqual(["openai/gpt-x", "azure/gpt-x", "claude-y"]);
});

test("the composer names the Default, then the running turn's model, then the pick once the turn is over", async () => {
  serve({ ...STATE, override: ref("provider-1", "openai/gpt-6.1-sol") });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  expect([nameShown(m.host), button(m.host)?.getAttribute("aria-label")]).toEqual(["gpt-6.1-sol", "Model for this thread: gpt-6.1-sol"]);
  m.rerender(<ThreadModelControl threadId="thr_1" wakeId="wake_1" />);
  act(() => useWakeModelStore.getState().set("wake_1", ref("kilo", "anthropic/claude-opus-5.5")));
  expect(nameShown(m.host)).toBe("claude-opus-5.5 · kilo");
  // Another wake's model is not this turn's.
  act(() => useWakeModelStore.getState().set("wake_2", ref("kilo", "deepseek/deepseek-v4.1-flash-1017")));
  expect(nameShown(m.host)).toBe("claude-opus-5.5 · kilo");
  m.rerender(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  expect(nameShown(m.host)).toBe("gpt-6.1-sol");
});

test("the menu offers Default and each provider's models, the pick checked; a choice is sent and named", async () => {
  const calls = serve();
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  // Radix opens a menu on pointerdown.
  act(() => { button(m.host)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the menu opens");
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(items.map((i) => [i.textContent, i.getAttribute("aria-checked")])).toEqual([
    ["Defaultclaude-opus-5-5", "true"],
    ["claude-opus-5-5", "false"],
    ["gpt-6.1-sol", "false"],
    ["claude-opus-5.5", "false"],
    ["deepseek-v4.1-flash-1017", "false"]
  ]);
  expect([...document.querySelectorAll('[data-slot="dropdown-menu-label"]')].map((l) => l.textContent)).toEqual(["Model for this thread", "provider-1", "kilo"]);
  act(() => { items[3]!.click(); });
  await settleUntil(() => nameShown(m.host) === "claude-opus-5.5 · kilo", "the pick is named");
  expect(puts(calls)).toStrictEqual([{ model: "kilo/anthropic/claude-opus-5.5" }]);
});

test("a change the server announces reads the thread's model again", async () => {
  const calls = serve();
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  const gets = () => calls.filter((c) => c.method === "GET" && c.url.endsWith("/api/agents/threads/thr_1/model")).length;
  expect(gets()).toBe(1);
  act(() => useThreadModelsStore.getState().changed("thr_1"));
  await settleUntil(() => gets() === 2, "read again");
  act(() => useThreadModelsStore.getState().changed("thr_other"));
  await settleUntil(() => gets() === 2, "no read for another thread");
});

test("on a phone the name opens a sheet of the same choices; Default sends null", async () => {
  onCleanup(fakePhoneWidth());
  const calls = serve({ ...STATE, override: ref("provider-1", "openai/gpt-6.1-sol") });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  act(() => { button(m.host)!.click(); });
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the sheet opens");
  const rows = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows.map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
    ["Defaultclaude-opus-5-5", "false"],
    ["claude-opus-5-5", "false"],
    ["✓gpt-6.1-sol", "true"],
    ["claude-opus-5.5", "false"],
    ["deepseek-v4.1-flash-1017", "false"]
  ]);
  act(() => { rows[0]!.click(); });
  await settleUntil(() => nameShown(m.host) === "claude-opus-5-5", "Default is named");
  expect(puts(calls)).toStrictEqual([{ model: null }]);
});

test("the stream tells each wake's model, drops it when the wake ends and all of them on a reconnect, and asks a changed thread again", () => {
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  const send = (type: string, data: unknown) => source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
  const model = ref("kilo", "anthropic/claude-opus-5.5");
  send(SSE_EVENTS.agentWakeModel, { threadId: "thr_1", wakeId: "wake_1", model });
  send(SSE_EVENTS.agentWakeModel, { threadId: "thr_2", wakeId: "wake_2", model });
  expect([...useWakeModelStore.getState().byWake.keys()]).toEqual(["wake_1", "wake_2"]);
  send(SSE_EVENTS.agentWakeFinished, { threadId: "thr_1", wakeId: "wake_1", status: "finished" });
  expect([...useWakeModelStore.getState().byWake.keys()]).toEqual(["wake_2"]);
  source.dispatchEvent(new Event("open"));
  expect(useWakeModelStore.getState().byWake.size).toBe(0);
  send(SSE_EVENTS.agentThreadModelChanged, { threadId: "thr_1" });
  expect(useThreadModelsStore.getState().revision.get("thr_1")).toBe(1);
});

test("a thread read mid-turn notes its turn's model", async () => {
  const model = ref("kilo", "anthropic/claude-opus-5.5");
  mockFetch(() => jsonResponse({ thread: { id: "thr_1" }, messages: [], activeWake: { wakeId: "wake_9", startedAt: "2026-10-24T01:00:00.000Z", model } }));
  await fetchThreadById("thr_1");
  expect(useWakeModelStore.getState().byWake.get("wake_9")).toEqual(model);
});

test("Default in the menu sends null, taking the thread back to its route's model", async () => {
  const calls = serve({ ...STATE, override: ref("provider-1", "openai/gpt-6.1-sol") });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) === "gpt-6.1-sol", "the pick is read");
  act(() => { button(m.host)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the menu opens");
  const first = document.querySelector<HTMLElement>('[role="menuitemradio"]')!;
  expect([first.textContent, first.getAttribute("aria-checked")]).toEqual(["Defaultclaude-opus-5-5", "false"]);
  act(() => { first.click(); });
  await settleUntil(() => nameShown(m.host) === "claude-opus-5-5", "Default is named");
  expect(puts(calls)).toStrictEqual([{ model: null }]);
});

test("a read that answers after a choice was sent does not undo it", async () => {
  let state: ThreadModelDto = STATE;
  let release: (() => void) | null = null;
  let gets = 0;
  mockFetch(async (call) => {
    if (call.method === "PUT") {
      const picked = (JSON.parse(String(call.init?.body)) as { model: string | null }).model;
      state = { ...state, override: state.choices.flatMap((g) => g.models).find((m) => m.ref === picked) ?? null };
      return jsonResponse({ model: state });
    }
    gets += 1;
    const seen = state;
    // The read the menu's opening starts is slow.
    if (gets === 2) await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ model: seen });
  });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) === "claude-opus-5-5", "the model is read");
  act(() => { button(m.host)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0 && release !== null, "the menu opens, its read held");
  act(() => { document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[3]!.click(); });
  await settleUntil(() => nameShown(m.host) === "claude-opus-5.5 · kilo", "the pick is named");
  await act(async () => { release!(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(nameShown(m.host)).toBe("claude-opus-5.5 · kilo");
});

test("a thread read that answers after the stream named a newer model for its turn keeps the newer one", async () => {
  let release: (() => void) | null = null;
  const older = ref("provider-1", "anthropic/claude-opus-5-5");
  const newer = ref("kilo", "anthropic/claude-opus-5.5");
  mockFetch(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return jsonResponse({ thread: { id: "thr_1" }, messages: [], activeWake: { wakeId: "wake_9", startedAt: "2026-10-24T01:00:00.000Z", model: older } });
  });
  const read = fetchThreadById("thr_1");
  await settleUntil(() => release !== null, "the read is under way");
  useWakeModelStore.getState().set("wake_9", newer);
  release!();
  await read;
  expect(useWakeModelStore.getState().byWake.get("wake_9")).toEqual(newer);
});

test("a reconnect reads a shown thread's model again: a change while the stream was down is not lost", async () => {
  const calls = serve();
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  act(() => { source.dispatchEvent(new Event("open")); });
  await settleUntil(() => calls.filter((c) => c.method === "GET").length === 2, "read again after the reconnect");
});

test("on a phone, focus goes back to the model's name once the sheet closes", async () => {
  onCleanup(fakePhoneWidth());
  serve();
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  act(() => { button(m.host)!.focus(); button(m.host)!.click(); });
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the sheet opens");
  act(() => { document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[2]!.click(); });
  await settleUntil(() => document.activeElement === button(m.host), "focus is back on the name");
});

test("of two reads of a thread, the later begun wins whichever answers last", async () => {
  const releases: Array<() => void> = [];
  const older = ref("provider-1", "anthropic/claude-opus-5-5");
  const newer = ref("kilo", "anthropic/claude-opus-5.5");
  let n = 0;
  mockFetch(async () => {
    const model = n++ === 0 ? older : newer;
    await new Promise<void>((resolve) => { releases.push(resolve); });
    return jsonResponse({ thread: { id: "thr_1" }, messages: [], activeWake: { wakeId: "wake_9", startedAt: "2026-10-24T01:00:00.000Z", model } });
  });
  const first = fetchThreadById("thr_1");
  const second = fetchThreadById("thr_1");
  await settleUntil(() => releases.length === 2, "both reads are under way");
  releases[1]!();
  await second;
  releases[0]!();
  await first;
  expect(useWakeModelStore.getState().byWake.get("wake_9")).toEqual(newer);
});

test("a control whose first read failed reads again on a reconnect, and shows", async () => {
  let fail = true;
  mockFetch(() => (fail ? new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } }) : jsonResponse({ model: STATE })));
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(button(m.host) === null).toBe(true);
  fail = false;
  const source = new EventTarget() as EventSource;
  attachSnapshotSseListeners(source, { cancelled: () => false, setConnection: () => {}, onReconnect: () => {} });
  act(() => { source.dispatchEvent(new Event("open")); });
  await settleUntil(() => nameShown(m.host) === "claude-opus-5-5", "the name shows after the reconnect");
});

test("on a phone the sheet's choices are one stop: the arrows, Home and End move among them", async () => {
  onCleanup(fakePhoneWidth());
  serve({ ...STATE, override: ref("provider-1", "openai/gpt-6.1-sol") });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  act(() => { button(m.host)!.click(); });
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the sheet opens");
  const rows = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(rows().map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
  const focused = () => (document.activeElement as HTMLElement | null)?.textContent ?? null;
  const key = (k: string) => act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });
  act(() => { rows()[2]!.focus(); });
  key("ArrowDown");
  expect(focused()).toBe("claude-opus-5.5");
  key("End");
  expect(focused()).toBe("deepseek-v4.1-flash-1017");
  key("ArrowDown");
  expect(focused()).toBe("Defaultclaude-opus-5-5");
  key("ArrowUp");
  expect(focused()).toBe("deepseek-v4.1-flash-1017");
  key("Home");
  expect(focused()).toBe("Defaultclaude-opus-5-5");
});

test("a second pick waits for the first to be answered, so the server ends on the last one", async () => {
  let state: ThreadModelDto = STATE;
  const held: Array<() => void> = [];
  const order: string[] = [];
  const calls = mockFetch(async (call) => {
    if (call.method === "PUT") {
      const picked = (JSON.parse(String(call.init?.body)) as { model: string | null }).model;
      // The first write is slow to reach the server.
      if (held.length === 0) await new Promise<void>((resolve) => { held.push(resolve); });
      order.push(String(picked));
      state = { ...state, override: state.choices.flatMap((g) => g.models).find((m) => m.ref === picked) ?? null };
    }
    return jsonResponse({ model: state });
  });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => nameShown(m.host) !== null, "the model is read");
  const pickNth = async (n: number) => {
    act(() => { button(m.host)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
    await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the menu opens");
    act(() => { document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[n]!.click(); });
    await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length === 0, "the menu closes");
  };
  await pickNth(2);
  await settleUntil(() => held.length === 1, "the first write is under way");
  await pickNth(3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls.filter((c) => c.method === "PUT").length).toBe(1);
  held[0]!();
  await settleUntil(() => order.length === 2, "both writes reached the server");
  expect(order).toStrictEqual(["provider-1/openai/gpt-6.1-sol", "kilo/anthropic/claude-opus-5.5"]);
  await settleUntil(() => nameShown(m.host) === "claude-opus-5.5 · kilo", "the last pick is named");
});

test("a read's answer still counts when a read begun after it failed", async () => {
  let releaseFirst: (() => void) | null = null;
  let gets = 0;
  mockFetch(async () => {
    const nth = ++gets;
    // The first read is slow; the one the change's announcement starts fails.
    if (nth === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
    if (nth === 2) return new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } });
    return jsonResponse({ model: STATE });
  });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  await settleUntil(() => releaseFirst !== null, "the first read goes out");
  act(() => useThreadModelsStore.getState().changed("thr_1"));
  await settleUntil(() => gets === 2, "the announced change is read, and fails");
  await act(async () => { releaseFirst!(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(nameShown(m.host)).toBe("claude-opus-5-5");
});

test("a read begun while a choice is on its way waits for it: the choice stays when a later read fails", async () => {
  let state: ThreadModelDto = STATE;
  let releasePut: (() => void) | null = null;
  let failNext = false;
  let gets = 0;
  mockFetch(async (call) => {
    if (call.method === "PUT") {
      const picked = (JSON.parse(String(call.init?.body)) as { model: string | null }).model;
      // Not saved yet: the server takes it when the test lets it.
      await new Promise<void>((resolve) => { releasePut = resolve; });
      state = { ...state, override: state.choices.flatMap((g) => g.models).find((m) => m.ref === picked) ?? null };
      return jsonResponse({ model: state });
    }
    gets += 1;
    if (failNext) return new Response(JSON.stringify({ error: "down" }), { status: 503, headers: { "content-type": "application/json" } });
    return jsonResponse({ model: state });
  });
  const m = mount(<ThreadModelControl threadId="thr_1" wakeId={null} />);
  onCleanup(m.unmount);
  const openMenu = () => act(() => { button(m.host)!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); });
  await settleUntil(() => nameShown(m.host) === "claude-opus-5-5", "the model is read");
  openMenu();
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0 && gets === 2, "the menu opens and reads");
  act(() => { document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')[3]!.click(); });
  await settleUntil(() => releasePut !== null, "the choice is on its way");
  // The menu opened again before the server took the choice.
  openMenu();
  await settleUntil(() => document.querySelectorAll('[role="menuitemradio"]').length > 0, "the menu opens again");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  await act(async () => { releasePut!(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  failNext = true;
  const before = gets;
  act(() => useThreadModelsStore.getState().changed("thr_1"));
  await settleUntil(() => gets > before, "the announced change is read, and fails");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(nameShown(m.host)).toBe("claude-opus-5.5 · kilo");
});
