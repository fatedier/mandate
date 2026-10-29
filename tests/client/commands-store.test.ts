import { afterEach, beforeEach, expect, test } from "bun:test";
import { useCommandsStore } from "../../src/client/store/commands.js";
import { runCleanups } from "../helpers/cleanup.js";
import { mockFetch } from "../helpers/fetch.js";

const LIST = [{ name: "/compact", description: "Summarize earlier messages to free up context", blocked: { running: "A turn is running" } }];
const thread = { type: "manager" as const, threadId: "thr_a" };
const worker = { type: "worker" as const, featureId: "f1" };

// Empty before each test as well as after: every file shares one process, and
// a file that draws a chat leaves its scopes' commands in the store (a worker
// f1's, read again here, was then never asked for).
beforeEach(() => {
  useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
});

afterEach(() => {
  runCleanups();
  useCommandsStore.setState({ byScope: new Map(), noticeByScope: new Map() });
});

test("a conversation's commands are asked for once, at its own route", async () => {
  const calls = mockFetch(() => Response.json({ commands: LIST }));
  await Promise.all([useCommandsStore.getState().load(thread), useCommandsStore.getState().load(thread)]);
  await useCommandsStore.getState().load(thread);
  await useCommandsStore.getState().load(worker);
  expect(calls.map((c) => `${c.method} ${c.url}`)).toStrictEqual([
    "GET /api/agents/threads/thr_a/commands",
    "GET /api/agents/workers/f1/commands"
  ]);
  expect(useCommandsStore.getState().byScope.get("manager:thr_a")).toEqual(LIST);
  expect(useCommandsStore.getState().byScope.get("worker:f1")).toEqual(LIST);
});

test("a list that could not be loaded leaves the conversation without commands, and is asked for again", async () => {
  let fail = true;
  const calls = mockFetch(() => (fail ? Response.json({ error: "open thread not found" }, { status: 404 }) : Response.json({ commands: LIST })));
  await useCommandsStore.getState().load(thread);
  expect(useCommandsStore.getState().byScope.has("manager:thr_a")).toBe(false);
  fail = false;
  await useCommandsStore.getState().load(thread);
  expect(calls.length).toBe(2);
  expect(useCommandsStore.getState().byScope.get("manager:thr_a")).toEqual(LIST);
});

test("running a draft posts it whole with its attachment count, and a failed request is a refusal", async () => {
  let answer: () => Response = () => Response.json({ taken: true, message: "Nothing to compact yet." });
  const calls = mockFetch(({ method }) => (method === "POST" ? answer() : Response.json({ commands: LIST })));
  expect(await useCommandsStore.getState().run(worker, "/compact", 0)).toEqual({ taken: true, message: "Nothing to compact yet." });
  expect([calls[0]!.method, calls[0]!.url, JSON.parse(String(calls[0]!.init!.body))]).toEqual(["POST", "/api/agents/workers/f1/commands", { text: "/compact", attachments: 0 }]);

  // A refusal is an answer, read as one.
  answer = () => Response.json({ taken: false, message: "A turn is running. Try again when it finishes." });
  expect(await useCommandsStore.getState().run(thread, "/compact now", 2)).toEqual({ taken: false, message: "A turn is running. Try again when it finishes." });
  expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ text: "/compact now", attachments: 2 });

  // The server could not be reached, or said no such thread: the draft stays, and it says why.
  answer = () => Response.json({ error: "open thread not found" }, { status: 404 });
  expect(await useCommandsStore.getState().run(thread, "/compact")).toEqual({ taken: false, message: "Couldn't run /compact: open thread not found" });
});

test("each conversation has its own line, set and cleared", () => {
  const { say } = useCommandsStore.getState();
  say(thread, "Nothing is running.");
  say(worker, "Nothing to compact yet.");
  expect([...useCommandsStore.getState().noticeByScope]).toEqual([["manager:thr_a", "Nothing is running."], ["worker:f1", "Nothing to compact yet."]]);
  const before = useCommandsStore.getState().noticeByScope;
  say(thread, "Nothing is running.");
  // The same line again changes nothing a subscriber would redraw for.
  expect(useCommandsStore.getState().noticeByScope).toBe(before);
  say(thread, null);
  expect([...useCommandsStore.getState().noticeByScope.keys()]).toEqual(["worker:f1"]);
});
