import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@/lib/api-paths";
import { useProviderChecks, type ProviderCheckState } from "@/routes/settings/useProviderChecks";
import { jsonResponse, withFetch } from "../helpers/fetch.js";
import { mount } from "../helpers/mount.js";

let hook: ReturnType<typeof useProviderChecks> | null = null;

function Probe() {
  hook = useProviderChecks();
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("a check asks the server once per provider at a time, with the max age, and keeps the answer", async () => {
  let release: (() => void) | null = null;
  await withFetch(
    (call) => new Promise((resolve) => {
      release = () => resolve(jsonResponse({ ok: true, providerName: "proxy", result: "ready", modelCount: 4, checkedAt: "2026-01-01T00:00:00.000Z" }));
      void call;
    }),
    async (calls) => {
      mount(<Probe />);
      act(() => hook!.runCheck("proxy", 3_600_000));
      act(() => hook!.runCheck("proxy", 3_600_000));
      expect(calls.map((c) => [c.url, c.method, JSON.parse(String(c.init?.body))])).toEqual([
        [api.settingsProviderCheck("proxy"), "POST", { maxAgeMs: 3_600_000 }]
      ]);
      expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "" });
      release!();
      await flush();
      expect(hook!.checks.proxy).toEqual({ phase: "done", check: { result: "ready", modelCount: 4, checkedAt: "2026-01-01T00:00:00.000Z" }, connection: "" });
      act(() => hook!.runCheck("proxy", 0));
      expect(calls.length).toBe(2);
    }
  );
});

test("a check the server could not answer reads as failed, with why", async () => {
  await withFetch(
    () => jsonResponse({ ok: false, error: "provider not found: proxy" }, 400),
    async () => {
      mount(<Probe />);
      act(() => hook!.runCheck("proxy", 0));
      await flush();
      const state = hook!.checks.proxy;
      expect(state?.phase).toBe("done");
      expect(state?.phase === "done" && state.check.result === "failed" ? state.check.message : null).toBe("provider not found: proxy");
    }
  );
});

test("an answer that is not a check reads as failed instead of breaking the page", async () => {
  await withFetch(
    () => jsonResponse({ ok: true, models: [] }),
    async () => {
      mount(<Probe />);
      act(() => hook!.runCheck("proxy", 0));
      await flush();
      const state = hook!.checks.proxy;
      expect(state?.phase === "done" ? state.check.result : null).toBe("failed");
    }
  );
});

test("a fresh check asked for while one is on its way (a save landed) drops that answer and checks again", async () => {
  const releases: Array<() => void> = [];
  await withFetch(
    (_call, index) => new Promise((resolve) => {
      releases.push(() => resolve(jsonResponse({ ok: true, providerName: "proxy", result: "ready", modelCount: index + 1, checkedAt: "2026-01-01T00:00:00.000Z" })));
    }),
    async (calls) => {
      mount(<Probe />);
      act(() => hook!.runCheck("proxy", 3_600_000));
      act(() => hook!.runCheck("proxy", 0));
      expect(calls.length).toBe(1);
      releases[0]!();
      await flush();
      // The answer for the settings before the save is not shown; a new check is on its way.
      expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "" });
      expect(calls.map((c) => JSON.parse(String(c.init?.body)).maxAgeMs)).toEqual([3_600_000, 0]);
      releases[1]!();
      await flush();
      expect(hook!.checks.proxy).toEqual({ phase: "done", check: { result: "ready", modelCount: 2, checkedAt: "2026-01-01T00:00:00.000Z" }, connection: "" });
    }
  );
});

test("an hour-old check asked for while one is on its way waits for that one", async () => {
  let release: (() => void) | null = null;
  await withFetch(
    () => new Promise((resolve) => {
      release = () => resolve(jsonResponse({ ok: true, providerName: "proxy", result: "ready", modelCount: 1, checkedAt: "2026-01-01T00:00:00.000Z" }));
    }),
    async (calls) => {
      mount(<Probe />);
      act(() => hook!.runCheck("proxy", 0));
      act(() => hook!.runCheck("proxy", 3_600_000));
      release!();
      await flush();
      expect(calls.length).toBe(1);
      expect(hook!.checks.proxy?.phase).toBe("done");
    }
  );
});

test("a check asked for other settings while one is on its way drops that answer and checks those settings", async () => {
  const releases: Array<() => void> = [];
  await withFetch(
    () => new Promise((resolve) => {
      releases.push(() => resolve(jsonResponse({ ok: true, providerName: "proxy", result: "ready", modelCount: 1, checkedAt: "2026-01-01T00:00:00.000Z" })));
    }),
    async (calls) => {
      mount(<Probe />);
      act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
      act(() => hook!.runCheck("proxy", 3_600_000, "address-2"));
      releases[0]!();
      await flush();
      expect(calls.length).toBe(2);
      expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "address-2" });
      releases[1]!();
      await flush();
      expect(hook!.checks.proxy?.connection).toBe("address-2");
      expect(hook!.checks.proxy?.phase).toBe("done");
    }
  );
});

/** Each check request waits for its own release; answer n says n+1 models. */
function heldChecks(): { releases: Array<() => void>; handler: (call: unknown, index: number) => Promise<Response> } {
  const releases: Array<() => void> = [];
  return {
    releases,
    handler: (_call, index) => new Promise((resolve) => {
      releases.push(() => resolve(jsonResponse({ ok: true, providerName: "proxy", result: "ready", modelCount: index + 1, checkedAt: "2026-01-01T00:00:00.000Z" })));
    })
  };
}

const readyWith = (modelCount: number, connection: string): ProviderCheckState =>
  ({ phase: "done", check: { result: "ready", modelCount, checkedAt: "2026-01-01T00:00:00.000Z" }, connection });

// The list asks again on every visit: a row that already says Ready for
// these settings keeps saying it while the answer comes back.
test("a list visit keeps the answer it has for the same settings while it asks again", async () => {
  const held = heldChecks();
  await withFetch(held.handler, async (calls) => {
    mount(<Probe />);
    act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
    held.releases[0]!();
    await flush();
    act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
    expect(calls.length).toBe(2);
    expect(hook!.checks.proxy).toEqual(readyWith(1, "address-1"));
    held.releases[1]!();
    await flush();
    expect(hook!.checks.proxy).toEqual(readyWith(2, "address-1"));
  });
});

test("a fresh check shows as checking over the answer it has", async () => {
  const held = heldChecks();
  await withFetch(held.handler, async () => {
    mount(<Probe />);
    act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
    held.releases[0]!();
    await flush();
    act(() => hook!.runCheck("proxy", 0, "address-1"));
    expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "address-1" });
  });
});

test("an answer for other settings is not kept while the new ones are checked", async () => {
  const held = heldChecks();
  await withFetch(held.handler, async () => {
    mount(<Probe />);
    act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
    held.releases[0]!();
    await flush();
    act(() => hook!.runCheck("proxy", 3_600_000, "address-2"));
    expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "address-2" });
  });
});

test("a check asked for while a quiet one is on its way shows as checking at once", async () => {
  const held = heldChecks();
  await withFetch(held.handler, async (calls) => {
    mount(<Probe />);
    act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
    held.releases[0]!();
    await flush();
    act(() => hook!.runCheck("proxy", 3_600_000, "address-1"));
    // Check pressed while the list's quiet one is on its way.
    act(() => hook!.runCheck("proxy", 0, "address-1"));
    expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "address-1" });
    // Other settings asked for while one is on its way: those are checking.
    act(() => hook!.runCheck("proxy", 3_600_000, "address-2"));
    expect(hook!.checks.proxy).toEqual({ phase: "checking", connection: "address-2" });
    held.releases[1]!();
    await flush();
    held.releases[2]!();
    await flush();
    expect(calls.length).toBe(3);
    expect(hook!.checks.proxy).toEqual(readyWith(3, "address-2"));
  });
});
