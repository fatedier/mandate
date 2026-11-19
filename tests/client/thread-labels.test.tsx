import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { ThreadLabels, ThreadLabelsSheet } from "@/routes/threads/ThreadLabels";
import { knownLabels } from "@/lib/known-labels";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { useTaskBoardStore } from "@/store/task-board";
import { usePersonalAgentStore } from "@/store/personal-agent";
import type { ArchivedThreadDto, ThreadLabelDto } from "@shared/api/agents";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mount, settleUntil, typeInto } from "../helpers/mount.js";
import { managerThreadDto, taskDto } from "../helpers/client-builders.js";
import { resetTaskBoardStore } from "../helpers/task-board.js";

// A thread's labels on the client: the store's add and remove (an open
// thread's or an archived one's), and the header's chips with the field that
// edits them in place, shared with a task's.

afterEach(() => {
  runCleanups();
  resetTaskBoardStore();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
    usePersonalAgentStore.setState({ agent: null });
  });
});

const ARCHIVED_AT = "2026-10-13T09:00:00.000Z";
const archivedEntry = (id: string, patch: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title: id, archivedAt: ARCHIVED_AT, lastActivityAt: ARCHIVED_AT, workers: 0, canvases: 0, labels: [], projects: [], ...patch
});
const owner = (name: string): ThreadLabelDto => ({ name, by: "owner" });
const agent = (name: string): ThreadLabelDto => ({ name, by: "agent" });
const store = () => useManagerThreadsStore.getState();
const labelsOf = (id: string) => (store().threads.get(id) ?? store().archived.find((t) => t.id === id))?.labels.map((l) => `${l.name}:${l.by}`);

/** thr_a open and thr_old archived, and a server that answers each label change. */
function seed(answer: (call: FetchCall) => Response | undefined = () => undefined, labels: ThreadLabelDto[] = []) {
  const calls = mockFetch((call) => answer(call) ?? jsonResponse({ archived: [] }));
  act(() => {
    store().replaceAll([managerThreadDto("thr_a", { labels }), managerThreadDto("thr_b")]);
    useManagerThreadsStore.setState({ archived: [archivedEntry("thr_old", { title: "Old release" })], archivedLoaded: true });
  });
  return calls;
}
const labelCalls = (calls: FetchCall[]) => calls.filter((c) => c.url.includes("/labels")).map((c) => `${c.method} ${c.url} ${c.init?.body ?? ""}`.trim());

test("the store puts a label on an open thread and on an archived one: the answer's labels are the thread's", async () => {
  const calls = seed((call) => (call.method === "POST" ? jsonResponse({ labels: [owner("billing")] }) : undefined));
  expect(await store().addLabel("thr_a", "billing")).toEqual({ ok: true });
  expect(await store().addLabel("thr_old", "billing")).toEqual({ ok: true });
  expect(labelCalls(calls)).toEqual([
    'POST /api/agents/manager/threads/thr_a/labels {"name":"billing"}',
    'POST /api/agents/manager/threads/thr_old/labels {"name":"billing"}'
  ]);
  expect([labelsOf("thr_a"), labelsOf("thr_old"), labelsOf("thr_b")]).toEqual([["billing:owner"], ["billing:owner"], []]);
});

test("a refused label is an error result, and the thread's labels stay", async () => {
  seed((call) => (call.method === "POST" ? jsonResponse({ error: "A label is a word or two: at most 40 characters." }, 400) : undefined), [owner("ops")]);
  expect(await store().addLabel("thr_a", "x".repeat(41))).toEqual({ error: "A label is a word or two: at most 40 characters." });
  expect(labelsOf("thr_a")).toEqual(["ops:owner"]);
});

test("removing names the label in the address and takes the answer's labels", async () => {
  const calls = seed((call) => (call.method === "DELETE" ? jsonResponse({ labels: [owner("ops")] }) : undefined), [owner("ops"), agent("R&D 3.21")]);
  expect(await store().removeLabel("thr_a", "R&D 3.21")).toEqual({ ok: true });
  expect(labelCalls(calls)).toEqual(["DELETE /api/agents/manager/threads/thr_a/labels/R%26D%203.21"]);
  expect(labelsOf("thr_a")).toEqual(["ops:owner"]);
});

test("an archived thread published again refreshes its entry; one newly archived carries its labels and projects", () => {
  seed();
  // Labelled from another tab: the stream publishes the archived thread.
  act(() => { store().upsert(managerThreadDto("thr_old", { title: "Old release, renamed", archivedAt: ARCHIVED_AT, labels: [agent("voice")], projects: ["project-voice"] })); });
  expect(store().archived.map((t) => [t.id, t.title, t.labels.map((l) => l.name), t.projects])).toEqual([["thr_old", "Old release, renamed", ["voice"], ["project-voice"]]]);
  act(() => { store().upsert(managerThreadDto("thr_a", { archivedAt: ARCHIVED_AT, labels: [owner("billing")], projects: ["project-billing"] })); });
  expect(store().archived.map((t) => [t.id, t.labels.map((l) => l.name), t.projects])).toEqual([
    ["thr_a", ["billing"], ["project-billing"]], ["thr_old", ["voice"], ["project-voice"]]
  ]);
});

test("the names in use on any task or thread, each once in its first spelling, sorted", () => {
  const tasks = [taskDto("tsk_a", { labels: [{ name: "atlas-api", by: "auto" }, { name: "Billing", by: "owner" }] })];
  const threads = [managerThreadDto("thr_a", { labels: [owner("billing"), agent("3.21")] })];
  const archived = [archivedEntry("thr_old", { labels: [owner("voice"), owner("Atlas-API")] })];
  expect(knownLabels(tasks, threads, archived)).toEqual(["3.21", "atlas-api", "Billing", "voice"]);
});

/** The header's labels as the thread page gives them: read from the store. */
function Header({ threadId }: { threadId: string }) {
  const labels = useManagerThreadsStore((s) => (s.threads.get(threadId) ?? s.archived.find((t) => t.id === threadId))?.labels ?? []);
  return <ThreadLabels threadId={threadId} labels={labels} />;
}
const chips = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[data-slot="thread-label"]')].map((chip) => `${chip.textContent?.trim()}:${chip.dataset.by}`);
const field = () => document.querySelector<HTMLElement>('[data-slot="thread-labels-field"]');
const input = () => field()!.querySelector<HTMLInputElement>('input[aria-label="Add a label"]')!;
const click = async (el: Element | null | undefined) => { await act(async () => { (el as HTMLElement).click(); await Promise.resolve(); }); };
const pressEnter = async (el: HTMLElement) => {
  await act(async () => { el.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await Promise.resolve(); });
};

test("the header shows up to three labels, then how many more; the agent's is marked and says who added it", () => {
  seed(undefined, [owner("billing"), agent("3.21"), owner("ops"), owner("voice"), owner("docs")]);
  act(() => { usePersonalAgentStore.setState({ agent: { name: "Juno", named: true } as never }); });
  const { host } = mount(<Header threadId="thr_a" />);
  expect(chips(host)).toEqual(["billing:owner", "3.21:agent", "ops:owner"]);
  expect(host.querySelector('[data-slot="thread-label-more"]')?.textContent).toBe("+2");
  expect(host.querySelector<HTMLElement>('[data-slot="thread-label"][data-by="agent"]')?.title).toBe("Added by Juno");
  expect(host.querySelector('button[aria-label="Add a label"]') !== null).toBe(true);
  // Nothing to edit is on screen until asked for.
  expect(field() === null).toBe(true);
});

test("a thread with no label shows the + alone", () => {
  seed();
  const { host } = mount(<Header threadId="thr_a" />);
  expect([chips(host), host.querySelector('[data-slot="thread-label-more"]') === null, host.querySelector('button[aria-label="Add a label"]') !== null]).toEqual([[], true, true]);
});

test("the + opens the field: every label with its ×, Enter adds, × removes, and a task's label is suggested", async () => {
  const calls = seed((call) => {
    if (call.method === "POST") return jsonResponse({ labels: [owner("ops"), agent("3.21"), owner(String(JSON.parse(String(call.init!.body)).name))] });
    if (call.method === "DELETE") return jsonResponse({ labels: [owner("ops")] });
    return undefined;
  }, [owner("ops"), agent("3.21")]);
  act(() => { useTaskBoardStore.getState().replaceAll([taskDto("tsk_a", { labels: [{ name: "billing", by: "owner" }] })]); });
  const { host } = mount(<Header threadId="thr_a" />);
  await click(host.querySelector('button[aria-label="Add a label"]'));
  await settleUntil(() => field() !== null, "the label field");
  expect(chips(field()!)).toEqual(["ops:owner", "3.21:agent"]);
  expect([...field()!.querySelectorAll("button[aria-label^='Remove label']")].map((b) => b.getAttribute("aria-label"))).toEqual(["Remove label ops", "Remove label 3.21"]);

  await typeInto(input(), "bil");
  const suggestions = () => [...document.querySelectorAll<HTMLElement>('[data-slot="thread-label-suggestion"]')].map((s) => s.textContent?.trim());
  expect(suggestions()).toEqual(["billing", 'Create "bil"']);
  await click(document.querySelector('[data-slot="thread-label-suggestion"]'));
  await settleUntil(() => labelsOf("thr_a")?.length === 3, "the suggested label on the thread");
  expect(labelCalls(calls)).toEqual(['POST /api/agents/manager/threads/thr_a/labels {"name":"billing"}']);
  expect(chips(host)).toEqual(["ops:owner", "3.21:agent", "billing:owner"]);

  await typeInto(input(), "voice");
  await pressEnter(input());
  await settleUntil(() => labelCalls(calls).length === 2, "the typed label sent");
  expect([labelCalls(calls)[1], input().value]).toEqual(['POST /api/agents/manager/threads/thr_a/labels {"name":"voice"}', ""]);

  await click(field()!.querySelector('[aria-label="Remove label 3.21"]'));
  await settleUntil(() => labelsOf("thr_a")?.length === 1, "the label removed");
  expect(labelCalls(calls)[2]).toBe("DELETE /api/agents/manager/threads/thr_a/labels/3.21");
  expect(chips(host)).toEqual(["ops:owner"]);
});

test("the chips open the field too, and an archived thread's labels are edited the same way", async () => {
  const calls = seed((call) => (call.method === "POST" ? jsonResponse({ labels: [owner("voice"), owner("ops")] }) : undefined));
  act(() => { useManagerThreadsStore.setState({ archived: [archivedEntry("thr_old", { labels: [owner("voice")] })] }); });
  const { host } = mount(<Header threadId="thr_old" />);
  await click(host.querySelector('[data-slot="thread-label"]'));
  await settleUntil(() => field() !== null, "the label field");
  await typeInto(input(), "ops");
  await pressEnter(input());
  await settleUntil(() => labelsOf("thr_old")?.length === 2, "the label on the archived thread");
  expect(labelCalls(calls)).toEqual(['POST /api/agents/manager/threads/thr_old/labels {"name":"ops"}']);
  expect(chips(host)).toEqual(["voice:owner", "ops:owner"]);
});

test("the phone's sheet is titled Labels and holds the same field", async () => {
  const calls = seed((call) => (call.method === "POST" ? jsonResponse({ labels: [owner("ops"), owner("voice")] }) : undefined), [owner("ops")]);
  function Sheet() {
    const labels = useManagerThreadsStore((s) => s.threads.get("thr_a")?.labels ?? []);
    return <ThreadLabelsSheet threadId="thr_a" labels={labels} open onOpenChange={() => {}} />;
  }
  mount(<Sheet />);
  await settleUntil(() => field() !== null, "the label field in the sheet");
  expect(document.querySelector('[data-slot="thread-labels-sheet"] h2')?.textContent).toBe("Labels");
  expect(chips(field()!)).toEqual(["ops:owner"]);
  await typeInto(input(), "voice");
  await pressEnter(input());
  await settleUntil(() => labelsOf("thr_a")?.length === 2, "the label added from the sheet");
  expect(labelCalls(calls)).toEqual(['POST /api/agents/manager/threads/thr_a/labels {"name":"voice"}']);
});
