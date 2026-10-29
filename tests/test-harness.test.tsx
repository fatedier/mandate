import { afterAll, beforeAll, expect, test } from "bun:test";
import { useEffect } from "react";
import { useLocation } from "react-router";
import { onCleanup, runCleanups } from "./helpers/cleanup.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { useState } from "react";
import { mount, mountAsync, settle, settleUntil } from "./helpers/mount.js";
import { readSse, sseFrame } from "./helpers/sse.js";
import { tempDir } from "./helpers/temp.js";
import { waitUntil } from "./helpers/wait.js";
import { agentMessage, contentOf, ok, stub, toolContext } from "./helpers/typed.js";
import { jsonResponse, mockFetch, withFetch } from "./helpers/fetch.js";
import { fakeClock, realClock } from "./helpers/fake-clock.js";
import { freshAgentEnv, freshProjectEnv, freshStoresEnv } from "./helpers/fixtures.js";
import { jest } from "bun:test";

// The shared harness (tests/helpers): what it promises every test that uses
// it. Some checks span two tests — the second reads what the cleanup after
// the first left — so these run in file order.

let unmounted = false;
function Tracked() {
  useEffect(() => () => { unmounted = true; }, []);
  return <p data-testid="tracked">here</p>;
}

test("mount renders into document.body, inside act", () => {
  const { host } = mount(<Tracked />);
  expect(document.body.contains(host)).toBe(true);
  expect(host.querySelector('[data-testid="tracked"]')?.textContent).toBe("here");
});

test("...and the cleanup after the test unmounted it and removed its host", () => {
  expect(unmounted).toBe(true);
  expect(document.querySelector('[data-testid="tracked"]') === null).toBe(true);
});

function Throws(): never {
  throw new Error("render failed");
}

test("a render that throws is still registered for cleanup", () => {
  const before = document.body.children.length;
  const consoleError = console.error;
  console.error = () => {};
  try {
    expect(() => mount(<Throws />)).toThrow("render failed");
  } finally {
    console.error = consoleError;
  }
  expect(document.body.children.length).toBe(before + 1);
});

test("...and its host is gone after it", () => {
  expect(document.body.children.length).toBe(0);
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

test("path wraps the tree in a MemoryRouter there, rerender too", () => {
  const view = mount(<Where />, { path: "/settings" });
  expect(view.host.querySelector('[data-testid="where"]')?.textContent).toBe("/settings");
  view.rerender(<p data-testid="where">{"again"}</p>);
  expect(view.host.querySelector('[data-testid="where"]')?.textContent).toBe("again");
});

function LoadsOnMount() {
  useEffect(() => {
    void fetch("/api/thing").then((r) => r.json()).then((body: { name: string }) => {
      document.body.dataset.loaded = body.name;
    });
  }, []);
  return null;
}

test("mountAsync returns once the fetch an effect started has answered", async () => {
  mockFetch(() => jsonResponse({ name: "project-1" }));
  await mountAsync(<LoadsOnMount />);
  await settle();
  expect(document.body.dataset.loaded).toBe("project-1");
  delete document.body.dataset.loaded;
});

test("mockFetch records each call with its method", async () => {
  const calls = mockFetch(() => jsonResponse({ ok: true }));
  await fetch("/api/a");
  await fetch(new URL("http://localhost/api/b"), { method: "post", body: "{}" });
  expect(calls.map((c) => [c.method, c.url])).toStrictEqual([["GET", "/api/a"], ["POST", "http://localhost/api/b"]]);
});

test("...and the network-refusing fetch is back after the test", async () => {
  await expect(fetch("/api/a")).rejects.toThrow("Test attempted a real network request");
});

test("the handler runs when fetch is called, so what it sets is there at once", async () => {
  // The request goes out at the call; only the answer comes later. A test can
  // count requests or take hold of a resolver right after the call.
  let handled = 0;
  let respond: ((response: Response) => void) | undefined;
  mockFetch(() => {
    handled += 1;
    return new Promise<Response>((resolve) => { respond = resolve; });
  });
  const answer = fetch("/api/held");
  expect(handled).toBe(1);
  respond!(jsonResponse({ held: true }));
  expect(await (await answer).json()).toEqual({ held: true });
});

test("an abort right after the call wins over an answer that is ready at once", async () => {
  mockFetch(() => jsonResponse({ late: true }));
  const controller = new AbortController();
  const answer = fetch("/api/slow", { signal: controller.signal });
  controller.abort();
  await expect(answer).rejects.toThrow();
  expect(await answer.catch((error: unknown) => (error as Error).name)).toBe("AbortError");
});

test("a request already aborted rejects without calling the handler", async () => {
  let called = 0;
  mockFetch(() => { called += 1; return jsonResponse({}); });
  const controller = new AbortController();
  controller.abort();
  await expect(fetch("/api/x", { signal: controller.signal })).rejects.toThrow();
  expect(called).toBe(0);
});

test("withFetch puts the previous fetch back as soon as run ends", async () => {
  const before = globalThis.fetch;
  await withFetch(() => jsonResponse({ n: 1 }), async (calls) => {
    expect(await (await fetch("/api/n")).json()).toEqual({ n: 1 });
    expect(calls).toHaveLength(1);
  });
  expect(globalThis.fetch).toBe(before);
});

function ThrowsOnUnmount() {
  useEffect(() => () => { throw new Error("cleanup failed"); }, []);
  return <p data-testid="leaky">here</p>;
}

test("an effect cleanup that throws still has its host removed, and the error surfaces", () => {
  const { host } = mount(<ThrowsOnUnmount />);
  const consoleError = console.error;
  console.error = () => {};
  try {
    expect(() => runCleanups()).toThrow("cleanup failed");
  } finally {
    console.error = consoleError;
  }
  expect(document.body.contains(host)).toBe(false);
});

/** What runCleanups threw, and whether it threw at all: a thrown undefined
 *  is a failure too. */
function outcome(): { threw: boolean; value: unknown } {
  try {
    runCleanups();
    return { threw: false, value: undefined };
  } catch (value) {
    return { threw: true, value };
  }
}

test("runCleanups rethrows a cleanup that threw undefined", () => {
  let ran = false;
  onCleanup(() => { ran = true; });
  onCleanup(() => { throw undefined; });
  expect(outcome()).toEqual({ threw: true, value: undefined });
  expect(ran).toBe(true);
});

test("runCleanups keeps the first failure even when it is null", () => {
  onCleanup(() => { throw new Error("second"); });
  onCleanup(() => { throw null; });
  expect(outcome()).toEqual({ threw: true, value: null });
});

test("an explicit signal: null disconnects a Request's own signal, as fetch does", async () => {
  let called = 0;
  mockFetch(() => { called += 1; return jsonResponse({ ok: true }); });
  const controller = new AbortController();
  controller.abort();
  const request = new Request("http://localhost/api/r", { signal: controller.signal });
  const response = await fetch(request, { signal: null });
  expect(await response.json()).toEqual({ ok: true });
  expect(called).toBe(1);
});

test("an abort's own reason is what the request rejects with, null included", async () => {
  mockFetch(() => jsonResponse({}));
  const controller = new AbortController();
  controller.abort(null);
  const reason = await fetch("/api/x", { signal: controller.signal }).then(() => "resolved", (error: unknown) => error);
  expect(reason).toBe(null);
});

test("ignoreAbort delivers an answer after the abort, for a test of the race where it lands as the abort comes", async () => {
  let respond: ((response: Response) => void) | undefined;
  mockFetch(() => new Promise<Response>((resolve) => { respond = resolve; }), { ignoreAbort: true });
  const controller = new AbortController();
  const answer = fetch("/api/late", { signal: controller.signal });
  controller.abort();
  respond!(jsonResponse({ late: true }));
  expect(await (await answer).json()).toEqual({ late: true });
});

test("parent mounts the host inside a given element, and the cleanup still removes it", () => {
  const outer = document.createElement("section");
  document.body.appendChild(outer);
  onCleanup(() => outer.remove());
  const { host } = mount(<p data-testid="inside">in</p>, { parent: outer });
  expect(host.parentElement === outer).toBe(true);
  expect(outer.querySelector('[data-testid="inside"]')?.textContent).toBe("in");
});

test("...and both are gone after it", () => {
  expect(document.querySelector('[data-testid="inside"]') === null).toBe(true);
  expect(document.querySelector("section") === null).toBe(true);
});

test("ignoreAbort still refuses a request aborted before the call: a network never sends it", async () => {
  let called = 0;
  const calls = mockFetch(() => { called += 1; return jsonResponse({}); }, { ignoreAbort: true });
  const controller = new AbortController();
  controller.abort();
  await expect(fetch("/api/x", { signal: controller.signal })).rejects.toThrow();
  expect(called).toBe(0);
  expect(calls).toHaveLength(1);
});

test("waitUntil returns the first truthy result of the condition", async () => {
  let n = 0;
  const value = await waitUntil(() => (++n >= 3 ? `after ${n}` : undefined), { interval: 1 });
  expect(value).toBe("after 3");
});

test("waitUntil gives up after its timeout, naming what it waited for", async () => {
  await expect(waitUntil(() => false, { timeout: 30, interval: 5, label: "the list to load" }))
    .rejects.toThrow("waitUntil timed out after 30ms: the list to load");
});

test("a label given as a function is read when the wait runs out, so it can say what was seen", async () => {
  const seen: string[] = [];
  await expect(waitUntil(() => { seen.push("tick"); return false; }, { timeout: 20, interval: 5, label: () => `done, after ${seen.length > 1 ? "several ticks" : "one tick"}` }))
    .rejects.toThrow("waitUntil timed out after 20ms: done, after several ticks");
});

test("a label function that throws still lets the timeout be reported", async () => {
  await expect(waitUntil(() => false, { timeout: 0, label: () => { throw new Error("format failed"); } }))
    .rejects.toThrow("waitUntil timed out after 0ms: (its label failed: format failed)");
});

test("an async condition that stalls still times out at the deadline", async () => {
  const started = Date.now();
  await expect(waitUntil(() => new Promise<boolean>(() => {}), { timeout: 20, label: "a stalled poll" }))
    .rejects.toThrow("waitUntil timed out after 20ms: a stalled poll");
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a truthy answer that only comes after the deadline is a timeout", async () => {
  await expect(waitUntil(() => new Promise<string>((resolve) => setTimeout(() => resolve("late"), 100)), { timeout: 10, label: "a slow poll" }))
    .rejects.toThrow("waitUntil timed out after 10ms: a slow poll");
});

test("a synchronous condition that turns truthy only after the deadline is a timeout", async () => {
  const slow = () => { const until = Date.now() + 50; while (Date.now() < until) { /* busy */ } return "late"; };
  await expect(waitUntil(slow, { timeout: 10, label: "a slow check" })).rejects.toThrow("waitUntil timed out after 10ms: a slow check");
});

test("the pause between polls never runs past the deadline", async () => {
  const started = Date.now();
  await expect(waitUntil(() => false, { timeout: 10, interval: 400, label: "never" })).rejects.toThrow("waitUntil timed out after 10ms: never");
  expect(Date.now() - started).toBeLessThan(200);
});

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(encoder.encode(c)); controller.close(); } });
}

test("readSse reads frames split across chunks, names, data and size", async () => {
  const first = sseFrame({ event: "snapshot", data: { a: 1 } });
  const events = readSse(streamOf(first.slice(0, 7), first.slice(7) + ": a comment\n\n", sseFrame({ data: "plain" })));
  expect(await events.next()).toEqual({ event: "snapshot", data: { a: 1 }, text: '{"a":1}', bytes: new TextEncoder().encode(first).length });
  expect(await events.next()).toMatchObject({ event: "message", data: "plain" });
  await expect(events.next()).rejects.toThrow("the event stream ended");
});

test("readSse reads CRLF frames, a CR and its LF split across chunks included, at their wire size", async () => {
  const crlf = 'event: snapshot\r\ndata: {"a":1}\r\n\r\n';
  const events = readSse(streamOf(crlf.slice(0, crlf.length - 3), crlf.slice(crlf.length - 3, crlf.length - 2), crlf.slice(crlf.length - 2), "data: 2\r\n\r\n"));
  expect(await events.next()).toEqual({ event: "snapshot", data: { a: 1 }, text: '{"a":1}', bytes: crlf.length });
  expect(await events.next()).toMatchObject({ event: "message", data: 2 });
});

test("readSse does not take a CRLF line ending for a blank line", async () => {
  const events = readSse(streamOf("event: one\r", "\ndata: 1\r\n\r\n"));
  expect(await events.next()).toMatchObject({ event: "one", data: 1 });
});

test("readSse refuses data that is not JSON, naming the event, unless asked for text", async () => {
  await expect(readSse(streamOf("event: projectsState\ndata: [object Object]\n\n")).next())
    .rejects.toThrow("readSse: projectsState's data is not JSON: [object Object]");
  expect(await readSse(streamOf("data: plain words\n\n"), { json: false }).next())
    .toMatchObject({ event: "message", data: "plain words", text: "plain words" });
});

test("readSse's until returns the match and every event seen up to it", async () => {
  const events = readSse(streamOf(sseFrame({ event: "featurePlans", data: {} }), sseFrame({ event: "projectsState", data: [] })));
  const { found, seen } = await events.until((frame) => frame.event === "projectsState");
  expect([found.event, seen]).toEqual(["projectsState", ["featurePlans", "projectsState"]]);
});

let madeDir = "";
test("tempDir makes a fresh directory for the test", () => {
  madeDir = tempDir("md-harness-");
  fs.writeFileSync(path.join(madeDir, "a.txt"), "x");
  expect(fs.existsSync(path.join(madeDir, "a.txt"))).toBe(true);
});

test("...and it is gone after it", () => {
  expect(madeDir === "").toBe(false);
  expect(fs.existsSync(madeDir)).toBe(false);
});

function Later() {
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShown(true), 30); return () => clearTimeout(t); }, []);
  return <p data-testid="later">{shown ? "shown" : "waiting"}</p>;
}

test("settleUntil lets the tree run inside act until the condition holds", async () => {
  const { host } = mount(<Later />);
  await settleUntil(() => host.textContent === "shown", "the later text");
  expect(host.textContent).toBe("shown");
});

test("settleUntil gives up after its rounds, naming what it waited for", async () => {
  mount(<p>never</p>);
  await expect(settleUntil(() => false, "something that never comes", 3)).rejects.toThrow("settleUntil gave up: something that never comes");
});

test("ok returns a result and throws on a tool's error arm", () => {
  const good: { results: number[] } | { error: string } = { results: [1] };
  expect(ok(good).results).toEqual([1]);
  const bad: { results: number[] } | { error: string } = { error: "no such thread" };
  expect(() => ok(bad)).toThrow("expected a result, got an error: no such thread");
});

test("contentOf narrows a message's content, and names the type it found otherwise", () => {
  const message = agentMessage({ content: { type: "text", text: "hi" } });
  expect(contentOf(message, "text").text).toBe("hi");
  expect(() => contentOf(message, "summary")).toThrow("expected summary content, got text");
});

test("stub refuses a member given as undefined: leave it out instead", () => {
  interface Store { list(): string[] }
  expect(() => stub<Store>({ list: undefined })).toThrow("stub: list is given as undefined; leave it out instead");
});

test("stub refuses a symbol-keyed member given as undefined too", () => {
  expect(() => stub<AsyncIterable<unknown>>({ [Symbol.asyncIterator]: undefined }))
    .toThrow("stub: Symbol(Symbol.asyncIterator) is given as undefined; leave it out instead");
});

test("toolContext and agentMessage refuse a required member given as undefined", () => {
  expect(() => toolContext({ scope: undefined })).toThrow("toolContext: scope is required; leave it out for the default");
  expect(() => agentMessage({ content: { type: "text", text: "x" }, role: undefined }))
    .toThrow("agentMessage: role is required; leave it out for the default");
});

// happy-dom's window timers stop for good when the real clock comes back
// while one waits in the fake clock: realClock lets those run first.
test("a window timer still waiting when the real clock comes back does not stop the window timers after it", async () => {
  fakeClock();
  window.setTimeout(() => {}, 0);
  realClock();
  expect(jest.isFakeTimers()).toBe(false);
  let fired = false;
  window.setTimeout(() => { fired = true; }, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(fired).toBe(true);
});

test("fakeClock gives the real clock back after the test", () => {
  expect(jest.isFakeTimers()).toBe(false);
});

// A fresh env made in a test is cleaned up after it, as a mount is: a test
// need not call its cleanup. One made in a file's beforeAll is the file's.
let made: string[] = [];
let fileEnv: ReturnType<typeof freshAgentEnv> | null = null;
beforeAll(() => { fileEnv = freshAgentEnv("md-harness-file-env-"); });
afterAll(() => { fileEnv?.cleanup(); });

test("an env made in a test is cleaned up after it, and its cleanup may be called again", () => {
  const envs = [freshAgentEnv("md-harness-env-"), freshStoresEnv("md-harness-env-"), freshProjectEnv("md-harness-env-")];
  made = envs.map((env) => env.dir);
  envs[0]!.cleanup();
  envs[0]!.cleanup();
  expect(fs.existsSync(made[0]!)).toBe(false);
  expect(made.slice(1).map((dir) => fs.existsSync(dir))).toEqual([true, true]);
});

test("...so after that test its dirs are gone and its databases closed; the file's env is still there", () => {
  expect(made.map((dir) => fs.existsSync(dir))).toEqual([false, false, false]);
  expect(fs.existsSync(fileEnv!.dir)).toBe(true);
  expect(fileEnv!.agentStore.getOrCreateGlobalThread().id).toBeTruthy();
});
