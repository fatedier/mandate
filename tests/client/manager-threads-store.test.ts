import { afterEach, expect, test } from "bun:test";
import { useManagerThreadsStore } from "../../src/client/store/manager-threads.js";
import type { ArchivedThreadDto, ManagerThreadDto } from "../../src/shared/api/agents.js";
import { mockFetch } from "../helpers/fetch.js";
import { managerThreadDto } from "../helpers/client-builders.js";

const t = (id: string, patch: Partial<ManagerThreadDto> = {}) =>
  managerThreadDto(id, { title: id, createdAt: "2026-09-27T00:00:00Z", lastActivityAt: "2026-09-27T00:00:00Z", ...patch });
afterEach(() => {
  useManagerThreadsStore.setState({ threads: new Map(), loaded: false, archived: [], archivedLoaded: false, archivedReadFailed: false });
});

const archivedEntry = (id: string, patch: Partial<ArchivedThreadDto> = {}): ArchivedThreadDto => ({
  id, title: id, archivedAt: "2026-10-13T09:00:00.000Z", workers: 0, canvases: 0, ...patch
});

/** Answers the archived list with what `list()` holds when each read arrives,
 *  each answer held until the test lets it go. */
function archivedServer(list: () => ArchivedThreadDto[]) {
  const reads: Array<() => void> = [];
  const calls = mockFetch(async ({ url, method }) => {
    if (method === "GET" && url.endsWith("/api/agents/manager/threads?archived=1")) {
      const answer = list();
      await new Promise<void>((resolve) => reads.push(resolve));
      return Response.json({ archived: answer });
    }
    return Response.json({ error: "unexpected" }, { status: 500 });
  });
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { calls, reads, settle };
}

test("replaceAll sets the list; upsert of an archived thread removes it", () => {
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a"), t("b")]);
  expect([...useManagerThreadsStore.getState().threads.keys()]).toEqual(["a", "b"]);
  expect(useManagerThreadsStore.getState().loaded).toBe(true);
  s.upsert(t("a", { archivedAt: "2026-09-27T01:00:00Z" }));
  expect([...useManagerThreadsStore.getState().threads.keys()]).toEqual(["b"]);
});

test("open burst replaces threads; seen from another tab clears New", () => {
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 9, seenSeq: 3 }), t("gone")]);
  s.replaceAll([t("a", { lastVisibleSeq: 9, seenSeq: 3 })]);
  expect(useManagerThreadsStore.getState().threads.has("gone")).toBe(false);
  // Another tab marked it seen: the server's update arrives over SSE.
  s.upsert(t("a", { lastVisibleSeq: 9, seenSeq: 9 }));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(9);
});

test("markSeen moves forward only, updates at once, and posts once per change", async () => {
  const calls: string[] = [];
  mockFetch(({ url, init }) => {
    calls.push(`${init?.method ?? "GET"} ${url} ${init?.body ?? ""}`);
    return new Response(JSON.stringify({ thread: t("a", { seenSeq: 7 }) }), { status: 200 });
  });
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 7, seenSeq: 2 })]);
  s.markSeen("a", 7);
  s.markSeen("a", 5);
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(7);
  await Promise.resolve();
  expect(calls.length).toBe(1);
  expect(calls[0]).toContain("/api/agents/manager/threads/a/seen");
  expect(calls[0]).toContain('"seq":7');
});

test("seen never moves back: a stale update or list keeps the higher seenSeq", () => {
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 9, seenSeq: 9 })]);
  // Published before this tab's seen POST landed.
  s.upsert(t("a", { lastVisibleSeq: 9, seenSeq: 3, title: "Renamed" }));
  expect(useManagerThreadsStore.getState().threads.get("a")).toMatchObject({ seenSeq: 9, title: "Renamed" });
  s.replaceAll([t("a", { lastVisibleSeq: 9, seenSeq: 3 })]);
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(9);
});

test("a seen write that fails is undone, so the next view marks it again", async () => {
  let fail = true;
  mockFetch(() => (fail
    ? new Response("down", { status: 502 })
    : Response.json({ thread: t("a", { seenSeq: 7 }) })));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 7, seenSeq: 2 })]);
  s.markSeen("a", 7);
  await new Promise((r) => setTimeout(r, 0));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(2);
  fail = false;
  s.markSeen("a", 7);
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(7);
});

test("a failed seen response does not undo what the server already confirmed", async () => {
  let release!: (r: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { release = resolve; }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 7, seenSeq: 2 })]);
  s.markSeen("a", 7);
  // The server applied it and published it; only the response was lost.
  s.upsert(t("a", { lastVisibleSeq: 7, seenSeq: 7 }));
  release(new Response("gateway timeout", { status: 504 }));
  await new Promise((r) => setTimeout(r, 0));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(7);
});

test("rename and archive report a lost connection as an error, not a throw", async () => {
  mockFetch(() => { throw new TypeError("Failed to fetch"); });
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a")]);
  expect(await s.rename("a", "New name")).toEqual({ error: "Failed to fetch" });
  expect(await s.archive("a")).toEqual({ error: "Failed to fetch" });
  expect(useManagerThreadsStore.getState().threads.get("a")?.title).toBe("a");
});

test("two seen writes that both fail fall back to what the server holds", async () => {
  const pending: Array<(r: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 11, seenSeq: 2 })]);
  s.markSeen("a", 10);
  s.markSeen("a", 11);
  pending[0]!(new Response("down", { status: 502 }));
  await new Promise((r) => setTimeout(r, 0));
  pending[1]!(new Response("down", { status: 502 }));
  await new Promise((r) => setTimeout(r, 0));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(2);
});

test("a rename answered after the thread was archived does not bring it back", async () => {
  let respond!: (r: Response) => void;
  // The archive reads the archived list again: answered at once.
  mockFetch(({ method }) => method === "GET" ? Response.json({ archived: [] }) : new Promise<Response>((resolve) => { respond = resolve; }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a")]);
  const renaming = s.rename("a", "New name");
  // Another tab archived it meanwhile.
  s.upsert(t("a", { archivedAt: "2026-09-27T02:00:00Z" }));
  respond(Response.json({ thread: t("a", { title: "New name" }) }));
  await renaming;
  expect(useManagerThreadsStore.getState().threads.has("a")).toBe(false);
});

test("a seen write the server confirmed stands when a later one fails", async () => {
  const pending: Array<(r: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 11, seenSeq: 2 })]);
  s.markSeen("a", 10);
  s.markSeen("a", 11);
  // The stream is down: only the responses say what the server holds.
  pending[0]!(Response.json({ thread: t("a", { lastVisibleSeq: 11, seenSeq: 10 }) }));
  await new Promise((r) => setTimeout(r, 0));
  pending[1]!(new Response("down", { status: 502 }));
  await new Promise((r) => setTimeout(r, 0));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(10);
});

test("a rename answer takes the title and keeps what arrived while it was in flight", async () => {
  let respond!: (r: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 5 })]);
  const renaming = s.rename("a", "New name");
  // The manager replied meanwhile.
  s.upsert(t("a", { lastVisibleSeq: 9, running: true, lastActivityAt: "2026-09-27T03:00:00Z" }));
  respond(Response.json({ thread: t("a", { title: "New name", lastVisibleSeq: 5 }) }));
  await renaming;
  expect(useManagerThreadsStore.getState().threads.get("a")).toMatchObject({
    title: "New name", lastVisibleSeq: 9, running: true, lastActivityAt: "2026-09-27T03:00:00Z"
  });
});

test("a late published copy with a lower seen mark does not lower what the server confirmed", async () => {
  const pending: Array<(r: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 11, seenSeq: 2 })]);
  s.markSeen("a", 10);
  pending[0]!(Response.json({ thread: t("a", { lastVisibleSeq: 11, seenSeq: 10 }) }));
  await new Promise((r) => setTimeout(r, 0));
  // An update published before that write lands late.
  s.upsert(t("a", { lastVisibleSeq: 11, seenSeq: 2 }));
  s.markSeen("a", 11);
  pending[1]!(new Response("down", { status: 502 }));
  await new Promise((r) => setTimeout(r, 0));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(10);
});

test("a create answered after the stream delivered the thread keeps the stream's newer copy, and an archive stays", async () => {
  const pending: Array<(r: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([]);
  const creating = s.create({ content: "Release project-1 3.21" });
  // The manager already replied, and the stream said so first.
  s.upsert(t("x", { lastVisibleSeq: 3, running: true, lastActivityAt: "2026-09-27T03:00:00Z" }));
  pending[0]!(Response.json({ thread: t("x", { lastVisibleSeq: 0, running: false }), message: null }));
  await creating;
  expect(useManagerThreadsStore.getState().threads.get("x")).toMatchObject({ lastVisibleSeq: 3, running: true });

  const creatingY = s.create({ content: "Another" });
  // Another tab archived it before this answer arrived.
  s.upsert(t("y", { archivedAt: "2026-09-27T03:00:00Z" }));
  pending[1]!(Response.json({ thread: t("y"), message: null }));
  await creatingY;
  expect(useManagerThreadsStore.getState().threads.has("y")).toBe(false);
});

test("a rename answer does not overwrite a newer title another tab set while it was in flight", async () => {
  let respond!: (r: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { title: "Old" })]);
  const renaming = s.rename("a", "Mine");
  s.upsert(t("a", { title: "From the other tab" }));
  respond(Response.json({ thread: t("a", { title: "Mine" }) }));
  await renaming;
  expect(useManagerThreadsStore.getState().threads.get("a")?.title).toBe("From the other tab");
});

test("a create answered after a full list without the thread does not bring it back", async () => {
  let respond!: (r: Response) => void;
  mockFetch(() => new Promise<Response>((resolve) => { respond = resolve; }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([]);
  const creating = s.create({ content: "Release project-1 3.21" });
  // Reconnected meanwhile: another tab had archived it, so the list omits it.
  s.replaceAll([t("other")]);
  respond(Response.json({ thread: t("x"), message: null }));
  await creating;
  expect(useManagerThreadsStore.getState().threads.has("x")).toBe(false);
});

test("a seen write confirmed after an overlapping one failed shows what the server confirmed", async () => {
  const pending: Array<(r: Response) => void> = [];
  mockFetch(() => new Promise<Response>((resolve) => { pending.push(resolve); }));
  const s = useManagerThreadsStore.getState();
  s.replaceAll([t("a", { lastVisibleSeq: 11, seenSeq: 2 })]);
  s.markSeen("a", 10);
  s.markSeen("a", 11);
  // The stream is down; the higher write fails first, the lower one lands after.
  pending[1]!(new Response("down", { status: 502 }));
  await new Promise((r) => setTimeout(r, 0));
  pending[0]!(Response.json({ thread: t("a", { lastVisibleSeq: 11, seenSeq: 10 }) }));
  await new Promise((r) => setTimeout(r, 0));
  expect(useManagerThreadsStore.getState().threads.get("a")?.seenSeq).toBe(10);
});

// The first message's images go to the server with it, and an image alone is
// a message: the request ids that let the stream match it are sent then too.
test("a new thread's first message carries its images, with or without text", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  mockFetch(({ init }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ thread: t("x"), message: null });
  });
  const image = { id: "img_1", type: "image" as const, name: "screen.png", mediaType: "image/png", data: "iVBORw==", sizeBytes: 4 };
  await useManagerThreadsStore.getState().create({ content: "What is wrong here?", attachments: [image] });
  await useManagerThreadsStore.getState().create({ attachments: [image] });
  expect(bodies[0]).toMatchObject({ content: "What is wrong here?", attachments: [image] });
  expect(typeof bodies[0]!.clientRequestId).toBe("string");
  expect(bodies[1]).toMatchObject({ attachments: [image] });
  expect(typeof bodies[1]!.clientRequestId).toBe("string");
  // Text alone sends no empty attachments.
  await useManagerThreadsStore.getState().create({ content: "Just text" });
  expect("attachments" in bodies[2]!).toBe(false);
});

// After an answer is refused (its question closed elsewhere), the page reads
// the thread again rather than wait for an event it may have missed.
test("refresh reads one thread again and takes it, unless an event changed it meanwhile", async () => {
  const asked = { id: "q_1", question: "Push?", options: [], askedAt: "2026-09-27T00:00:00Z" };
  useManagerThreadsStore.getState().replaceAll([t("A", { questions: [asked] }), t("B")]);
  let answer!: (r: Response) => void;
  const calls = mockFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const refreshed = useManagerThreadsStore.getState().refresh("A");
  answer(Response.json({ threads: [t("A"), t("B", { title: "renamed" })] }));
  await refreshed;
  expect(calls.map((c) => [c.method, c.url])).toStrictEqual([["GET", "/api/agents/manager/threads"]]);
  expect(useManagerThreadsStore.getState().threads.get("A")!.questions).toEqual([]);
  // Only that thread is taken.
  expect(useManagerThreadsStore.getState().threads.get("B")!.title).toBe("B");
  // An event that lands while the read is on its way is newer than it.
  useManagerThreadsStore.getState().upsert(t("A", { questions: [asked] }));
  const again = useManagerThreadsStore.getState().refresh("A");
  useManagerThreadsStore.getState().upsert(t("A", { questions: [asked], title: "from the event" }));
  answer(Response.json({ threads: [t("A")] }));
  await again;
  expect(useManagerThreadsStore.getState().threads.get("A")!.title).toBe("from the event");
  // A read that fails changes nothing.
  mockFetch(() => new Response("down", { status: 500 }));
  await useManagerThreadsStore.getState().refresh("A");
  expect(useManagerThreadsStore.getState().threads.get("A")!.title).toBe("from the event");
});


test("the archived list is read from the server in its order, and marks the list loaded", async () => {
  const server = archivedServer(() => [archivedEntry("b", { workers: 2, canvases: 1 }), archivedEntry("a")]);
  const read = useManagerThreadsStore.getState().loadArchived();
  await server.settle();
  expect(useManagerThreadsStore.getState().archivedLoaded).toBe(false);
  server.reads.shift()!();
  await read;
  expect(useManagerThreadsStore.getState().archived.map((x) => [x.id, x.workers, x.canvases])).toEqual([["b", 2, 1], ["a", 0, 0]]);
  expect(useManagerThreadsStore.getState().archivedLoaded).toBe(true);
});

test("a thread archived moves into the archived list at once, and the list is read again for its counts", async () => {
  const server = archivedServer(() => [archivedEntry("a", { title: "project-1 cache expiry", workers: 2 })]);
  useManagerThreadsStore.getState().replaceAll([t("a", { title: "project-1 cache expiry" })]);
  useManagerThreadsStore.getState().upsert(t("a", { title: "project-1 cache expiry", archivedAt: "2026-10-13T09:00:00.000Z" }));
  const state = useManagerThreadsStore.getState();
  expect(state.threads.has("a")).toBe(false);
  expect(state.archived.map((x) => [x.id, x.title, x.archivedAt])).toEqual([["a", "project-1 cache expiry", "2026-10-13T09:00:00.000Z"]]);
  await server.settle();
  expect(server.calls.length).toBe(1);
  server.reads.shift()!();
  await server.settle();
  expect(useManagerThreadsStore.getState().archived[0]?.workers).toBe(2);
});

test("a list read that went out before an archive is not applied: the list is read again", async () => {
  let list = [archivedEntry("b")];
  const server = archivedServer(() => list);
  void useManagerThreadsStore.getState().loadArchived();
  await server.settle();
  // Archived while that read is out: its answer would not have it.
  list = [archivedEntry("a"), archivedEntry("b")];
  useManagerThreadsStore.getState().upsert(t("a", { archivedAt: "2026-10-13T09:00:00.000Z" }));
  server.reads.shift()!();
  await server.settle();
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["a"]);
  expect(server.calls.length).toBe(2);
  server.reads.shift()!();
  await server.settle();
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["a", "b"]);
});

test("a deleted thread leaves the archived list, and a list read before the delete does not bring it back", async () => {
  const server = archivedServer(() => [archivedEntry("a"), archivedEntry("b")]);
  useManagerThreadsStore.setState({ archived: [archivedEntry("a"), archivedEntry("b")], archivedLoaded: true });
  void useManagerThreadsStore.getState().loadArchived();
  await server.settle();
  useManagerThreadsStore.getState().removeDeleted("a");
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["b"]);
  server.reads.shift()!();
  await server.settle();
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["b"]);
});

test("deleting one archived thread sends its delete and drops it; a refusal comes back as the server's words", async () => {
  const calls = mockFetch(({ url }) => url.endsWith("/threads/b")
    ? Response.json({ error: "Its work is still stopping. Try again in a moment." }, { status: 409 })
    : Response.json({ ok: true, deleted: { threads: 2, workers: 1, canvases: 0 } }));
  useManagerThreadsStore.setState({ archived: [archivedEntry("a"), archivedEntry("b")], archivedLoaded: true });
  expect(await useManagerThreadsStore.getState().deleteArchived("a")).toEqual({ ok: true });
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual(["DELETE /api/agents/manager/threads/a"]);
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["b"]);
  expect(await useManagerThreadsStore.getState().deleteArchived("b")).toEqual({ error: "Its work is still stopping. Try again in a moment." });
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["b"]);
});

test("deleting every archived thread says how many went and how many were left, then reads the list again", async () => {
  const calls = mockFetch(({ method }) => method === "DELETE"
    ? Response.json({ ok: true, count: 2, skipped: 1 })
    : Response.json({ archived: [archivedEntry("c")] }));
  useManagerThreadsStore.setState({ archived: [archivedEntry("a"), archivedEntry("b"), archivedEntry("c")], archivedLoaded: true });
  expect(await useManagerThreadsStore.getState().deleteAllArchived()).toEqual({ ok: true, count: 2, skipped: 1 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual([
    "DELETE /api/agents/manager/threads?archived=1",
    "GET /api/agents/manager/threads?archived=1"
  ]);
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["c"]);
});

test("a list read that fails is said so, not taken as no archived threads; the next one that answers clears it", async () => {
  let fail = true;
  // An id no earlier test deleted: the store keeps those out of every list.
  mockFetch(() => fail ? Response.json({ error: "down" }, { status: 502 }) : Response.json({ archived: [archivedEntry("never-deleted")] }));
  await useManagerThreadsStore.getState().loadArchived();
  expect(useManagerThreadsStore.getState()).toMatchObject({ archivedLoaded: false, archivedReadFailed: true, archived: [] });
  fail = false;
  await useManagerThreadsStore.getState().loadArchived();
  expect(useManagerThreadsStore.getState()).toMatchObject({ archivedLoaded: true, archivedReadFailed: false });
  expect(useManagerThreadsStore.getState().archived.map((x) => x.id)).toEqual(["never-deleted"]);
});

test("a new thread's first message carries its mentions; one with no words carries none", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  mockFetch(({ init }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    return Response.json({ thread: t(`n${bodies.length}`), message: null });
  });
  const s = useManagerThreadsStore.getState();
  s.replaceAll([]);
  const general = { kind: "thread", id: "thr_general", label: "General" };
  await s.create({ content: "Continue @General", mentions: [general] });
  expect(bodies[0]).toMatchObject({ content: "Continue @General", mentions: [general] });
  await s.create({ title: "Empty", mentions: [general] });
  expect("mentions" in bodies[1]!).toBe(false);
  await s.create({ content: "plain" });
  expect("mentions" in bodies[2]!).toBe(false);
});
