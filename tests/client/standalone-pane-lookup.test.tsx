import { expect, test } from "bun:test";
import { act } from "react";
import { useStandalonePaneLookup } from "../../src/client/routes/terminal/useStandalonePaneLookup.js";
import { mockFetch } from "../helpers/fetch.js";
import { mountAsync, settle } from "../helpers/mount.js";

const lookup = (currentCommand: string, foreground: string[], paneId = "%64") => ({
  paneId, sessionName: "project-4", windowName: "work-2", windowId: "@4", windowIndex: 4, paneIndex: 0,
  active: true, currentCommand, currentPath: "/tmp", paneWidth: 91, paneHeight: 20, projectId: null,
  foregroundProcesses: foreground.map((command) => ({ command }))
});

let seen: { status: string; command: string | undefined; foreground: string[] } | null = null;
/** Each state the page has settled on, in order ("found <program>", "error",
 *  "missing"): a slow run can land two reads between two looks, and the last
 *  one alone would hide the first. */
let shown: string[] = [];
let lastError: string | null = null;
let retry: () => void = () => {};
function Probe({ refreshMs }: { refreshMs: number }) {
  const result = useStandalonePaneLookup({ enabled: true, paneId: "%64", refreshMs });
  const { pane, status } = result;
  seen = { status, command: pane?.currentCommand, foreground: (pane?.foregroundProcesses ?? []).map((p) => p.command ?? "") };
  const mark = status === "found" ? `found ${pane?.currentCommand}` : status;
  if (status !== "loading" && status !== "idle" && shown.at(-1) !== mark) shown.push(mark);
  lastError = result.error;
  retry = result.retry;
  return null;
}

async function mount(refreshMs: number) {
  shown = [];
  await mountAsync(<Probe refreshMs={refreshMs} />);
  await settle(10);
}

/** Lets the tree run until `predicate` holds. The reads run on real timers,
 *  which a busy run stretches past any fixed wait (a 10ms settle saw the first
 *  read still loading once the fetch took 30ms). */
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${label}`);
    await settle(5);
  }
}

test("a pane page opened on a shell learns that its program became codex behind node", async () => {
  const answers = [lookup("zsh", ["-zsh"]), lookup("node", ["node /opt/homebrew/bin/codex"])];
  mockFetch(() => Response.json(answers.length > 1 ? answers.shift() : answers[0]));
  await mount(40);
  await until(() => shown.includes("found node"), "the read after the program changed");
  expect(shown).toStrictEqual(["found zsh", "found node"]);
  expect(seen).toEqual({ status: "found", command: "node", foreground: ["node /opt/homebrew/bin/codex"] });
});

test("a refresh that fails keeps what the page knew instead of calling the pane missing", async () => {
  const calls = mockFetch((_call, index) => {
    if (index === 0) return Response.json(lookup("codex", ["codex"]));
    throw new Error("offline");
  });
  await mount(40);
  // A third read is asked for only once the failed second one is handled.
  await until(() => calls.length > 2, "the failed refresh to be handled");
  expect(shown).toStrictEqual(["found codex"]);
  expect(seen).toEqual({ status: "found", command: "codex", foreground: ["codex"] });
});

test("a later read that says the pane is gone leaves the page as it was", async () => {
  const calls = mockFetch((_call, index) =>
    index === 0 ? Response.json(lookup("codex", ["codex"])) : Response.json({ error: "pane not found" }, { status: 404 }));
  await mount(40);
  await until(() => calls.length > 2, "the 404 to be handled");
  expect(shown).toStrictEqual(["found codex"]);
  expect(seen).toEqual({ status: "found", command: "codex", foreground: ["codex"] });
});

test("a first read that cannot reach Mandate is an error with its reason, not a missing pane, and it can retry", async () => {
  mockFetch((_call, index) => {
    if (index === 0) throw new TypeError("Failed to fetch");
    return Response.json(lookup("zsh", ["-zsh"]));
  });
  await mount(60_000);
  await until(() => seen?.status === "error", "the first read");
  expect(lastError).toBe("Failed to fetch");
  act(() => retry());
  await until(() => seen?.status === "found", "the retry's answer");
  expect(seen).toEqual({ status: "found", command: "zsh", foreground: ["-zsh"] });
  expect(lastError).toBeNull();
});

test("a Retry loads again until its answer", async () => {
  let answer: (() => void) | null = null;
  mockFetch((_call, index) => index === 0
    ? Response.json({ error: "tmux server not running" }, { status: 500 })
    : new Promise<Response>((resolve) => { answer = () => resolve(Response.json(lookup("zsh", ["-zsh"]))); }));
  await mount(60_000);
  await until(() => seen?.status === "error", "the first read");
  act(() => retry());
  // Held until answered: the read is asked for, and the page loads meanwhile.
  await until(() => answer !== null, "the retry's read");
  await settle(10);
  expect(seen!.status).toBe("loading");
  answer!();
  await until(() => seen?.status === "found", "the retry's answer");
  expect(seen).toEqual({ status: "found", command: "zsh", foreground: ["-zsh"] });
});

test("a first read the server fails is an error with the server's reason", async () => {
  mockFetch(() => Response.json({ error: "tmux server not running" }, { status: 500 }));
  await mount(60_000);
  await until(() => seen?.status === "error", "the first read");
  expect(lastError).toBe("tmux server not running");
});

test("a first read that says the pane is not there is a missing pane", async () => {
  mockFetch(() => Response.json({ error: "pane not found" }, { status: 404 }));
  await mount(60_000);
  await until(() => seen?.status === "missing", "the first read");
  expect(lastError).toBeNull();
});

test("until a pane has been found, a later answer counts: an unreachable first read, then a 404, is a missing pane", async () => {
  mockFetch((_call, index) => {
    if (index === 0) throw new TypeError("Failed to fetch");
    return Response.json({ error: "pane not found" }, { status: 404 });
  });
  await mount(40);
  await until(() => shown.includes("missing"), "the 404 after the failed read");
  expect(shown).toStrictEqual(["error", "missing"]);
  expect(lastError).toBeNull();
});

test("until a pane has been found, a later read that finds it shows it", async () => {
  mockFetch((_call, index) => {
    if (index === 0) throw new TypeError("Failed to fetch");
    return Response.json(lookup("zsh", ["-zsh"]));
  });
  await mount(40);
  await until(() => shown.includes("found zsh"), "the read that finds the pane");
  expect(shown).toStrictEqual(["error", "found zsh"]);
  expect(seen).toEqual({ status: "found", command: "zsh", foreground: ["-zsh"] });
});

test("a missing pane stays missing when a later read gets no answer", async () => {
  const calls = mockFetch((_call, index) => {
    if (index === 0) return Response.json({ error: "pane not found" }, { status: 404 });
    throw new TypeError("Failed to fetch");
  });
  await mount(40);
  await until(() => calls.length > 2, "the failed read after the 404 to be handled");
  expect(shown).toStrictEqual(["missing"]);
  expect(lastError).toBeNull();
});


// The page moves between Sessions panes in place (the switcher, Recent): the
// hook lives on, holding what it read for the previous pane.
async function moveInPlace(first: () => Response) {
  let answerSecond: (() => void) | null = null;
  mockFetch((call) => call.url.endsWith(encodeURIComponent("%64"))
    ? first()
    : new Promise<Response>((resolve) => {
        answerSecond = () => resolve(Response.json(lookup("vim", ["vim"], "%65")));
      }));
  const renders: Array<{ routed: string; pane: string | undefined; window: string | undefined; status: string; error: string | null }> = [];
  function Routed({ paneId }: { paneId: string }) {
    const r = useStandalonePaneLookup({ enabled: true, paneId, refreshMs: 60_000 });
    renders.push({ routed: paneId, pane: r.pane?.paneId, window: r.windowData?.windowName, status: r.status, error: r.error });
    return null;
  }
  const mounted = await mountAsync(<Routed paneId="%64" />);
  await until(() => ["found", "missing", "error"].includes(renders.at(-1)?.status ?? ""), "the first pane's read");
  const before = renders.at(-1);
  mounted.rerender(<Routed paneId="%65" />);
  // The second pane's read is asked for and held: what the page says meanwhile.
  await until(() => answerSecond !== null, "the second pane's read");
  await settle(10);
  const waiting = renders.filter((r) => r.routed === "%65");
  answerSecond!();
  await until(() => renders.at(-1)?.routed === "%65" && renders.at(-1)?.status === "found", "the second pane's answer");
  return { before, waiting, after: renders.at(-1) };
}

test("moving to another pane, nothing of the previous pane is said for it until its own read answers", async () => {
  const { before, waiting, after } = await moveInPlace(() => Response.json(lookup("zsh", ["-zsh"])));
  expect(before).toEqual({ routed: "%64", pane: "%64", window: "work-2", status: "found", error: null });
  expect(waiting.length).toBeGreaterThan(0);
  for (const render of waiting) expect(render).toEqual({ routed: "%65", pane: undefined, window: undefined, status: "loading", error: null });
  expect(after).toEqual({ routed: "%65", pane: "%65", window: "work-2", status: "found", error: null });
});

test("moving on from a missing or failed pane, the next one loads instead of taking its verdict", async () => {
  const fromMissing = await moveInPlace(() => Response.json({ error: "pane not found" }, { status: 404 }));
  expect(fromMissing.before!.status).toBe("missing");
  for (const render of fromMissing.waiting) expect(render.status).toBe("loading");
  expect(fromMissing.after!.status).toBe("found");
  const fromFailed = await moveInPlace(() => Response.json({ error: "tmux server not running" }, { status: 500 }));
  expect(fromFailed.before).toMatchObject({ status: "error", error: "tmux server not running" });
  for (const render of fromFailed.waiting) expect(render).toMatchObject({ status: "loading", error: null });
  expect(fromFailed.after!.status).toBe("found");
});
