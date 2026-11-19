import { afterEach, describe, expect, test } from "bun:test";
import { usePersonalAgentStore } from "../../src/client/store/personal-agent.js";
import type { PersonalAgentDto, PersonalHandoffDto } from "../../src/shared/api/personal-agent.js";
import { stub } from "../helpers/typed.js";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, mockFetch } from "../helpers/fetch.js";
import { settle, settleUntil } from "../helpers/mount.js";

afterEach(() => {
  runCleanups();
  usePersonalAgentStore.setState({ agent: null });
});

const asked = { id: "q_1", question: "Tag 3.21 today?", options: [], askedAt: "2026-10-14T10:00:00Z" };
const agent = (patch: Partial<PersonalAgentDto> = {}) => stub<PersonalAgentDto>({ threadId: "t_g", name: "Juno", questions: [asked], ...patch });

// After an answer is refused (its question closed elsewhere), the page reads
// the agent again rather than wait for an event it may have missed.
test("refresh reads the agent again and takes it, unless an event changed it meanwhile", async () => {
  usePersonalAgentStore.getState().setAgent(agent());
  let answer!: (r: Response) => void;
  const calls = mockFetch(() => new Promise<Response>((resolve) => { answer = resolve; }));
  const refreshed = usePersonalAgentStore.getState().refresh();
  answer(Response.json({ agent: agent({ questions: [] }) }));
  await refreshed;
  expect(calls.map((c) => [c.method, c.url])).toStrictEqual([["GET", "/api/agents/personal"]]);
  expect(usePersonalAgentStore.getState().agent!.questions).toEqual([]);
  // An event that lands while the read is on its way is newer than it.
  usePersonalAgentStore.getState().setAgent(agent());
  const again = usePersonalAgentStore.getState().refresh();
  usePersonalAgentStore.getState().setAgent(agent({ name: "Atlas" }));
  answer(Response.json({ agent: agent({ questions: [] }) }));
  await again;
  expect(usePersonalAgentStore.getState().agent!.name).toBe("Atlas");
  expect(usePersonalAgentStore.getState().agent!.questions).toEqual([asked]);
});

// The page's own reads and writes, raced against the events that change the
// same agent while they are on their way.
describe("seen and name writes", () => {
  afterEach(() => {
    runCleanups();
    usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  });

  const agent = (over: Partial<PersonalAgentDto>): PersonalAgentDto => ({ threadId: "thr_g", name: "", named: false, unread: false, voiceConfigured: true, lastVisibleSeq: 0, seenSeq: 0, questions: [], ...over });

  test("a seen answer that arrives after a newer update does not bring back what it replaced", async () => {
    let answer!: () => void;
    mockFetch((call) => {
      if (call.url.includes("/api/agents/personal/seen")) {
        return new Promise<void>((resolve) => { answer = resolve; }).then(() => jsonResponse({ agent: agent({ name: "Jarvis", named: true, unread: false, lastVisibleSeq: 4 }) }));
      }
      return jsonResponse({});
    });
    usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 4 }));
    usePersonalAgentStore.getState().markSeen(4);
    expect(usePersonalAgentStore.getState().agent?.unread).toBe(false);
    // A new reply, published while the seen write was in flight.
    usePersonalAgentStore.getState().setAgent(agent({ name: "Jarvis", named: true, unread: true, lastVisibleSeq: 6 }));
    answer();
    await settle(20);
    expect(usePersonalAgentStore.getState().agent).toMatchObject({ unread: true, lastVisibleSeq: 6 });
  });

  test("the state read after saving a name does not replace an update that arrived while it was in flight", async () => {
    let answer!: () => void;
    mockFetch((call) => {
      if (call.url.includes("/api/settings/config")) return jsonResponse({ ok: true });
      if (call.url.endsWith("/api/agents/personal")) {
        return new Promise<void>((resolve) => { answer = resolve; }).then(() => jsonResponse({ agent: agent({ name: "Friday", named: true, lastVisibleSeq: 4 }) }));
      }
      return jsonResponse({});
    });
    usePersonalAgentStore.getState().setAgent(agent({}));
    const saved = usePersonalAgentStore.getState().saveName("Friday");
    await settleUntil(() => typeof answer === "function", "the state was asked for");
    // The rename's own event, then a reply, published while the read was in flight.
    usePersonalAgentStore.getState().setAgent(agent({ name: "Friday", named: true, unread: true, lastVisibleSeq: 6 }));
    answer();
    expect(await saved).toEqual({ ok: true });
    expect(usePersonalAgentStore.getState().agent).toMatchObject({ unread: true, lastVisibleSeq: 6 });
  });
});

describe("handoffs", () => {
  afterEach(() => {
    runCleanups();
    usePersonalAgentStore.setState({ agent: null, handoffs: new Map() });
  });

  const handoff = (over: Partial<PersonalHandoffDto>): PersonalHandoffDto => ({
    id: "hof_1", kind: "worker", state: "delivered", text: "Keep the old install script", spoken: false,
    workerId: "wkr_1", workerName: "release", ownerThreadTitle: "Docs overhaul",
    threadId: "thr_w", threadTitle: null, newThreadTitle: null, reply: null, reason: null, stop: null,
    createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z", repliedAt: null, ...over
  });

  test("a copy older than the one held never replaces it; within one millisecond the later state wins", () => {
    const store = usePersonalAgentStore.getState();
    store.upsertHandoff(handoff({ state: "replied", reply: "ok", updatedAt: "2026-10-05T10:05:00.000Z", repliedAt: "2026-10-05T10:05:00.000Z" }));
    store.upsertHandoff(handoff({ state: "delivered", updatedAt: "2026-10-05T10:01:00.000Z" }));
    expect(usePersonalAgentStore.getState().handoffs.get("hof_1")?.state).toBe("replied");
    store.upsertHandoff(handoff({ id: "hof_2", state: "delivered", updatedAt: "2026-10-05T10:00:00.000Z" }));
    store.upsertHandoff(handoff({ id: "hof_2", state: "queued", updatedAt: "2026-10-05T10:00:00.000Z" }));
    expect(usePersonalAgentStore.getState().handoffs.get("hof_2")?.state).toBe("delivered");
    store.upsertHandoff(handoff({ id: "hof_2", state: "replied", reply: "done", updatedAt: "2026-10-05T10:00:00.000Z" }));
    expect(usePersonalAgentStore.getState().handoffs.get("hof_2")?.state).toBe("replied");
  });

  test("a read after an event brought a newer copy keeps the newer one, and keeps handoffs it did not ask for", async () => {
    const asked: string[] = [];
    mockFetch((call) => { asked.push(call.url); return jsonResponse({ handoffs: [handoff({ state: "delivered", updatedAt: "2026-10-05T10:01:00.000Z" })] }); });
    const store = usePersonalAgentStore.getState();
    store.upsertHandoff(handoff({ state: "replied", reply: "ok", updatedAt: "2026-10-05T10:05:00.000Z", repliedAt: "2026-10-05T10:05:00.000Z" }));
    store.upsertHandoff(handoff({ id: "hof_old", updatedAt: "2026-09-01T10:00:00.000Z" }));
    await store.loadHandoffs(["hof_1"]);
    expect(asked).toStrictEqual(["/api/agents/personal/handoffs?ids=hof_1"]);
    expect(usePersonalAgentStore.getState().handoffs.get("hof_1")?.state).toBe("replied");
    expect(usePersonalAgentStore.getState().handoffs.has("hof_old")).toBe(true);
  });

  test("a long history is read in batches the server answers whole", async () => {
    const asked: string[][] = [];
    mockFetch((call) => {
      const ids = new URL(call.url, "http://x").searchParams.get("ids")!.split(",");
      asked.push(ids);
      return jsonResponse({ handoffs: ids.map((id) => handoff({ id })) });
    });
    const ids = Array.from({ length: 450 }, (_, i) => `hof_${String(i).padStart(3, "0")}`);
    await usePersonalAgentStore.getState().loadHandoffs(ids);
    expect(asked.map((batch) => batch.length)).toStrictEqual([200, 200, 50]);
    expect(usePersonalAgentStore.getState().handoffs.size).toBe(450);
  });
});
