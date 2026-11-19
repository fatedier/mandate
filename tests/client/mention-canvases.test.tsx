import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { MemoryRouter, useLocation, type Location } from "react-router";
import { ChatInput } from "@/routes/window/chat/ChatInput";
import { UserMessage } from "@/routes/window/chat/UserMessage";
import { useManagerThreadsStore } from "@/store/manager-threads";
import { usePersonalAgentStore } from "@/store/personal-agent";
import { resetCanvasTitles } from "@/store/canvas-titles";
import type { CanvasMentionDto } from "@shared/api/canvas";
import type { PersonalAgentDto } from "@shared/api/personal-agent";
import type { Mention } from "@shared/mentions";
import { onCleanup, runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch, type FetchCall } from "../helpers/fetch.js";
import { mountAsync, settle, settleUntil, typeInto } from "../helpers/mount.js";
import { managerThreadDto } from "../helpers/client-builders.js";
import { stub } from "../helpers/typed.js";

// The composer's @ names canvases too, after the threads: a bare @ shows the
// four newest of each and how many more there are; typing narrows both, up to
// eight each. A canvas row says where it came from and when it last changed.
// Sent, a canvas is a tag that opens it over the page; one gone since is words.

afterEach(() => {
  runCleanups();
  resetCanvasTitles();
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(), archived: [] });
    usePersonalAgentStore.setState({ agent: null });
  });
});

const at = (minute: number) => new Date(Date.UTC(2026, 10, 6, 10, minute)).toISOString();
const THREADS = Array.from({ length: 6 }, (_, i) => managerThreadDto(`thr_${i}`, { title: `Release step ${i}`, createdAt: at(i), lastActivityAt: at(i) }));
const CANVASES: CanvasMentionDto[] = [
  { id: "cnv_thumb000001", title: "Thumbnail cache report", kind: "report", updatedAt: at(50), origin: { kind: "worker", name: "thumb-fix" } },
  { id: "cnv_design00001", title: "Settings page design", kind: "design", updatedAt: at(40), origin: { kind: "agent" } },
  { id: "cnv_release0001", title: "Release checklist", kind: "report", updatedAt: at(30), origin: { kind: "thread", name: "Release 3.21" } },
  ...Array.from({ length: 7 }, (_, i): CanvasMentionDto => ({ id: `cnv_old0000000${i}`, title: `Old note ${i}`, kind: "report", updatedAt: at(20 - i), origin: null }))
];

/** The server's search: titles holding q, newest first, as many as asked. */
function canvasServer(call: FetchCall): Response {
  const url = new URL(call.url, "http://x");
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const limit = Number(url.searchParams.get("limit"));
  const hits = CANVASES.filter((c) => c.title.toLowerCase().includes(q));
  return jsonResponse({ canvases: hits.slice(0, limit), total: hits.length });
}

/** `hold`: the queries whose answer waits until released. */
async function composer(hold: (q: string) => boolean = () => false) {
  act(() => {
    useManagerThreadsStore.setState({ threads: new Map(THREADS.map((t) => [t.id, t])), archived: [] });
    usePersonalAgentStore.setState({ agent: stub<PersonalAgentDto>({ name: "Juno", named: true }) });
  });
  const asked: string[] = [];
  const held: Array<() => void> = [];
  mockFetch((call) => {
    const url = new URL(call.url, "http://x");
    asked.push(`${url.searchParams.get("q")}|${url.searchParams.get("limit")}`);
    if (!hold(url.searchParams.get("q") ?? "")) return canvasServer(call);
    return new Promise<Response>((resolve) => { held.push(() => resolve(canvasServer(call))); });
  });
  const original = globalThis.getComputedStyle;
  onCleanup(() => { globalThis.getComputedStyle = original; });
  globalThis.getComputedStyle = (() => ({ lineHeight: "20px" })) as unknown as typeof globalThis.getComputedStyle;
  const sent: Mention[][] = [];
  const { host } = await mountAsync(
    <MemoryRouter>
      <ChatInput onSend={(_content, _attachments, mentions) => { sent.push(mentions ?? []); }} mentions={{ excludeId: null }} />
    </MemoryRouter>
  );
  const textarea = () => host.getElementsByTagName("textarea")[0]!;
  const type = async (text: string) => { await typeInto(textarea(), text, text.length, text.length); await settle(); };
  const key = (name: string) => act(async () => {
    textarea().dispatchEvent(new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  /** Each group: its heading, its rows (title, and what is beside it), and the line under it. */
  const groups = () => [...document.querySelectorAll<HTMLElement>('[data-slot="mention-list"] [role="group"]')].map((group) => ({
    heading: group.getAttribute("aria-label"),
    rows: [...group.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => [
      row.querySelector('[data-slot="mention-title"]')!.textContent,
      row.querySelector('[data-slot="mention-meta"]')?.textContent ?? null
    ]),
    more: group.querySelector('[data-slot="group-more"]')?.textContent ?? null
  }));
  const release = async () => { await act(async () => { for (const go of held.splice(0)) go(); }); await settle(); };
  return { textarea, type, key, groups, asked, sent, release };
}

test("a bare @ shows the four newest threads and canvases, and how many more of each", async () => {
  const c = await composer();
  await c.type("@");
  const [threads, canvases] = c.groups();
  expect(threads!.heading).toBe("Threads");
  expect(threads!.rows.map(([title]) => title)).toEqual(["Release step 5", "Release step 4", "Release step 3", "Release step 2"]);
  expect(threads!.more).toBe("2 more · keep typing");
  expect(canvases!.heading).toBe("Canvases");
  expect(canvases!.rows.map(([title]) => title)).toEqual(["Thumbnail cache report", "Settings page design", "Release checklist", "Old note 0"]);
  // Where each came from: a worker, the agent by its name, a thread; then when.
  expect(canvases!.rows.map(([, meta]) => meta!.split(" · ")[0])).toEqual(["thumb-fix", "Juno", "Release 3.21", expect.any(String)]);
  expect(canvases!.more).toBe("6 more · keep typing");
  expect(c.asked).toEqual(["|4"]);
});

test("typing narrows both groups, eight at most each; a group with nothing left is not shown", async () => {
  const c = await composer();
  await c.type("@Re");
  expect(c.groups().map((g) => [g.heading, g.rows.map(([title]) => title), g.more])).toEqual([
    ["Threads", ["Release step 5", "Release step 4", "Release step 3", "Release step 2", "Release step 1", "Release step 0"], null],
    ["Canvases", ["Thumbnail cache report", "Release checklist"], null]
  ]);
  expect(c.asked.at(-1)).toBe("Re|8");
  await c.type("@Old");
  expect(c.groups().map((g) => [g.heading, g.rows.length, g.more])).toEqual([["Canvases", 7, null]]);
});

// Threads narrow at once; canvases wait for the server. Until every group has
// answered what is typed, the list keeps what it showed, so it changes once
// rather than shrinking and growing back.
test("while the canvases for what is typed are on their way, the list keeps what it showed, then changes once", async () => {
  const c = await composer((q) => q === "Old");
  await c.type("@");
  const before = c.groups();
  expect(before.map((g) => [g.heading, g.rows.length])).toEqual([["Threads", 4], ["Canvases", 4]]);
  // The bare @ asked for four canvases: one of them is an old note. Shown at
  // once, "@Old" would be that one row, then seven when the answer comes.
  await c.type("@Old");
  expect(c.groups()).toEqual(before);
  await c.release();
  expect(c.groups().map((g) => [g.heading, g.rows.length])).toEqual([["Canvases", 7]]);
});

test("an answer that does not come lets the list change anyway, soon after", async () => {
  const c = await composer((q) => q === "Old");
  await c.type("@");
  await c.type("@Old");
  // What it already has that fits what is typed: the one old note.
  await settleUntil(() => c.groups().length === 1, "the list moved on without the answer", 200, 2_000);
  expect(c.groups().map((g) => [g.heading, g.rows.map(([title]) => title)])).toEqual([["Canvases", ["Old note 0"]]]);
});

// A wait that ran out once is not carried to the next time the same words are typed.
test("typing the same words again waits again, though an earlier wait for them ran out", async () => {
  const c = await composer((q) => q === "Old");
  await c.type("@");
  await c.type("@Old");
  await settleUntil(() => c.groups().length === 1, "the first wait ran out", 200, 2_000);
  await c.type("@");
  const bare = c.groups();
  expect(bare.map((g) => [g.heading, g.rows.length])).toEqual([["Threads", 4], ["Canvases", 4]]);
  await c.type("@Old");
  expect(c.groups()).toEqual(bare);
});

test("a canvas picked is written as its title and sent as a canvas", async () => {
  const c = await composer();
  await c.type("Check @Thumb");
  expect(c.groups().map((g) => g.heading)).toEqual(["Canvases"]);
  await c.key("Enter");
  expect(c.textarea().value).toBe("Check @Thumbnail cache report ");
  await typeInto(c.textarea(), "Check @Thumbnail cache report now", 33, 33);
  await c.key("Enter");
  expect(c.sent).toEqual([[{ kind: "canvas", id: "cnv_thumb000001", label: "Thumbnail cache report" }]]);
});

let where: Location | null = null;
function Where() {
  where = useLocation();
  return null;
}

test("sent, a canvas is a tag with its kind's icon that opens it over the page; one gone since is words", async () => {
  mockFetch(() => jsonResponse({ canvases: [{ id: "cnv_thumb000001", title: "Thumbnail cache report", kind: "report" }] }));
  const mentions: Mention[] = [
    { kind: "canvas", id: "cnv_thumb000001", label: "Thumbnail cache report" },
    { kind: "canvas", id: "cnv_gone0000001", label: "Gone report" }
  ];
  const { host } = await mountAsync(
    <MemoryRouter initialEntries={["/threads/thr_a"]}>
      <UserMessage text="Check @Thumbnail cache report and @Gone report" status="persisted" mentions={mentions} />
      <Where />
    </MemoryRouter>
  );
  await settle();
  const tags = [...host.querySelectorAll<HTMLElement>('[data-slot="mention-tag"]')];
  expect(tags.map((tag) => [tag.textContent, tag.querySelector('[data-slot="mention-icon"]')?.getAttribute("data-kind") ?? null])).toEqual([["Thumbnail cache report", "report"]]);
  expect(host.querySelector('[data-slot="bubble-text"]')!.textContent).toBe("Check Thumbnail cache report and @Gone report");
  await act(async () => { tags[0]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); });
  expect(where!.pathname).toBe("/canvas/cnv_thumb000001");
  expect((where!.state as { backgroundLocation?: Location } | null)?.backgroundLocation?.pathname).toBe("/threads/thr_a");
});

test("a canvas deleted after its tag was drawn turns the tag back into words, there and wherever it is drawn later", async () => {
  let there = true;
  mockFetch(() => jsonResponse({ canvases: there ? [{ id: "cnv_thumb000001", title: "Thumbnail cache report", kind: "report" }] : [] }));
  const mentions: Mention[] = [{ kind: "canvas", id: "cnv_thumb000001", label: "Thumbnail cache report" }];
  const view = <MemoryRouter><UserMessage text="Check @Thumbnail cache report" status="persisted" mentions={mentions} /></MemoryRouter>;
  const first = await mountAsync(view);
  await settle();
  expect(first.host.querySelectorAll('[data-slot="mention-tag"]').length).toBe(1);
  // Deleted, here or on another device: the server says the canvas changed.
  there = false;
  act(() => { window.dispatchEvent(new CustomEvent("mandate:canvas-updated", { detail: { canvasId: "cnv_thumb000001", workerId: null } })); });
  await settle();
  expect(first.host.querySelectorAll('[data-slot="mention-tag"]').length).toBe(0);
  expect(first.host.textContent).toBe("Check @Thumbnail cache report");
  // Drawn again later (another conversation shown, then this one): still words.
  const second = await mountAsync(view);
  await settle();
  expect(second.host.querySelectorAll('[data-slot="mention-tag"]').length).toBe(0);
});

test("a canvas deleted while this page was away (asleep, offline) turns its tag into words once the page is back", async () => {
  let there = true;
  mockFetch(() => jsonResponse({ canvases: there ? [{ id: "cnv_thumb000001", title: "Thumbnail cache report", kind: "report" }] : [] }));
  const mentions: Mention[] = [{ kind: "canvas", id: "cnv_thumb000001", label: "Thumbnail cache report" }];
  const { host } = await mountAsync(<MemoryRouter><UserMessage text="Check @Thumbnail cache report" status="persisted" mentions={mentions} /></MemoryRouter>);
  await settle();
  expect(host.querySelectorAll('[data-slot="mention-tag"]').length).toBe(1);
  // Deleted meanwhile: no word of it came. The page's stream opens again.
  there = false;
  act(() => { window.dispatchEvent(new window.Event("mandate:sse-open")); });
  await settle();
  expect(host.querySelectorAll('[data-slot="mention-tag"]').length).toBe(0);
});
