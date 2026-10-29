import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { api } from "@/lib/api-paths";
import {
  useSaveUnit,
  useSettingsConfig,
  type SaveUnitState
} from "@/routes/settings/settings-config";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "@/routes/settings/types";
import { runCleanups } from "../helpers/cleanup.js";
import { jsonResponse, withFetch } from "../helpers/fetch.js";
import { mount, settleRounds } from "../helpers/mount.js";

function render(node: ReactNode): void {
  mount(node);
}

async function actAsync<T>(run: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await run();
  });
  return result as T;
}

/** Only the fields the probes below read; cast keeps the fixtures small. */
function mockConfig(preferences: string, restartRequired = false): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired,
    agent: { preferences }
  } as SettingsConfigResponse;
}

type Store = ReturnType<typeof useSettingsConfig>;
let storeState: Store | null = null;

function StoreProbe(): null {
  storeState = useSettingsConfig();
  return null;
}

type PreferencesForm = { preferences: string };
let unitState: SaveUnitState<PreferencesForm> | null = null;

function PreferencesUnitProbe(props: {
  buildPatch?: (form: PreferencesForm, config: SettingsConfigResponse) => SettingsConfigUpdate;
  restartReason?: string;
}): null {
  unitState = useSaveUnit<PreferencesForm>({
    derive: (config) => ({ preferences: config.agent.preferences }),
    buildPatch: props.buildPatch ?? ((form) => ({ agent: { preferences: form.preferences } })),
    restartReason: props.restartReason
  });
  return null;
}

type VolatileForm = { preferences: string; draftId: number };
let volatileState: SaveUnitState<VolatileForm> | null = null;

function VolatileUnitProbe(): null {
  volatileState = useSaveUnit<VolatileForm>({
    derive: (config) => ({ preferences: config.agent.preferences, draftId: 0 }),
    buildPatch: (form) => ({ agent: { preferences: form.preferences } }),
    serialize: (form) => form.preferences
  });
  return null;
}

afterEach(() => {
  // Unmount before the probes' captured state is cleared.
  runCleanups();
  storeState = null;
  unitState = null;
  volatileState = null;
});

describe("SettingsConfigProvider / useSettingsConfig", () => {
  test("mount fetches config; failure sets loadError; reload retries", async () => {
    await withFetch(
      (_call, index) =>
        index === 0
          ? jsonResponse({ ok: false, error: "config unavailable" }, 500)
          : jsonResponse(mockConfig("auto")),
      async (fetchCalls) => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        expect(storeState!.loading).toBe(true);
        await settleRounds();
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0]!.url).toBe(api.settingsConfig);
        expect(fetchCalls[0]!.init?.method ?? "GET").toBe("GET");
        expect(storeState!.loading).toBe(false);
        expect(storeState!.config).toBeNull();
        expect(storeState!.loadError).toBe("config unavailable");

        await actAsync(() => storeState!.reload());
        await settleRounds();
        expect(fetchCalls.length).toBe(2);
        expect(storeState!.loading).toBe(false);
        expect(storeState!.loadError).toBe("");
        expect(storeState!.config?.agent.preferences).toBe("auto");
      }
    );
  });

  test("savePatch POSTs the exact patch as JSON and replaces config", async () => {
    const patch: SettingsConfigUpdate = { agent: { preferences: "English" } };
    await withFetch(
      (_call, index) =>
        index === 0 ? jsonResponse(mockConfig("auto")) : jsonResponse(mockConfig("English")),
      async (fetchCalls) => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        await actAsync(() => storeState!.savePatch(patch));
        await settleRounds();
        expect(fetchCalls.length).toBe(2);
        const post = fetchCalls[1]!;
        expect(post.url).toBe(api.settingsConfig);
        expect(post.init?.method).toBe("POST");
        expect((post.init?.headers as Record<string, string>)["content-type"]).toBe(
          "application/json"
        );
        expect(post.init?.body).toBe(JSON.stringify(patch));
        expect(storeState!.config?.agent.preferences).toBe("English");
        // restartRequired: true never came back, and no reason was recorded
        expect(storeState!.restartReasons).toEqual([]);
      }
    );
  });

  test("restart reasons collect only for restart-required saves with a reason, deduplicated", async () => {
    const responses = [
      mockConfig("auto"),
      mockConfig("a", true), // reason passed + restart → appended
      mockConfig("b", true), // same reason again → deduplicated
      mockConfig("c", true), // second distinct reason → appended
      mockConfig("d", false), // reason passed but no restart → skipped
      mockConfig("e", true) // restart but no reason passed → skipped
    ];
    await withFetch(
      (_call, index) => jsonResponse(responses[index]!),
      async () => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        await actAsync(() => storeState!.savePatch({}, "Server settings"));
        await actAsync(() => storeState!.savePatch({}, "Server settings"));
        await actAsync(() => storeState!.savePatch({}, "Voice settings"));
        await actAsync(() => storeState!.savePatch({}, "Memory settings"));
        await actAsync(() => storeState!.savePatch({}));
        await settleRounds();
        expect(storeState!.restartReasons).toEqual(["Server settings", "Voice settings"]);

        act(() => {
          storeState!.clearRestartReasons();
        });
        await settleRounds();
        expect(storeState!.restartReasons).toEqual([]);
      }
    );
  });

  test("a stale reload response cannot regress config past a newer save", async () => {
    let releaseStaleReload = () => {};
    await withFetch(
      (_call, index) => {
        if (index === 0) return jsonResponse(mockConfig("auto"));
        if (index === 1) {
          // The reload GET: requested before the save's POST, resolved after
          // it, carrying the pre-save snapshot.
          return new Promise<Response>((resolve) => {
            releaseStaleReload = () => resolve(jsonResponse(mockConfig("auto")));
          });
        }
        // The save POST and any guard retry both see the saved state.
        return jsonResponse(mockConfig("English"));
      },
      async (fetchCalls) => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        expect(storeState!.config?.agent.preferences).toBe("auto");

        let staleReload!: Promise<void>;
        act(() => {
          staleReload = storeState!.reload(); // GET in flight, unresolved
        });
        await settleRounds();
        expect(fetchCalls.length).toBe(2);

        await actAsync(() => storeState!.savePatch({ agent: { preferences: "English" } }));
        await settleRounds();
        expect(storeState!.config?.agent.preferences).toBe("English");

        releaseStaleReload();
        await actAsync(async () => {
          await staleReload;
        });
        await settleRounds();
        // The pre-save snapshot must be discarded, not applied over the save.
        expect(storeState!.config?.agent.preferences).toBe("English");
        expect(storeState!.loading).toBe(false);
      }
    );
  });

  test("savePatch propagates save errors and keeps the existing config", async () => {
    await withFetch(
      (_call, index) =>
        index === 0
          ? jsonResponse(mockConfig("auto"))
          : jsonResponse({ ok: false, error: "invalid port" }, 400),
      async () => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        expect(storeState!.config).not.toBeNull();

        let thrown: Error | null = null;
        try {
          await actAsync(() => storeState!.savePatch({ server: { port: -1 } }, "Server settings"));
        } catch (err) {
          thrown = err as Error;
        }
        expect(thrown?.message).toBe("invalid port");
        await settleRounds();
        expect(storeState!.config?.agent.preferences).toBe("auto");
        expect(storeState!.restartReasons).toEqual([]);
      }
    );
  });
});

describe("a save outlives the visit that made it", () => {
  /** A server whose saves answer only when let go; a read answers with what it holds then. */
  function server(start: string) {
    let held = mockConfig(start);
    const saves: Array<() => void> = [];
    const handler = (call: { method?: string; init?: RequestInit }) => {
      if (call.method === "POST") {
        const body = JSON.parse(String(call.init!.body)) as { agent: { preferences: string } };
        return new Promise<Response>((resolve) => {
          saves.push(() => {
            held = mockConfig(body.agent.preferences, Boolean((body as { restart?: boolean }).restart));
            resolve(jsonResponse(held));
          });
        });
      }
      return jsonResponse(held);
    };
    return { handler, letGo: () => saves.shift()!() };
  }

  test("leaving Settings with a save on its way: the next visit waits for it, says it is saving, and shows what it saved", async () => {
    const s = server("auto");
    await withFetch(s.handler, async (calls) => {
      const first = mount(<SettingsConfigProvider><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      act(() => { void storeState!.savePatch({ agent: { preferences: "English" } }).catch(() => {}); });
      await settleRounds();
      first.unmount();
      mount(<SettingsConfigProvider><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      expect(storeState!.saving).toBe(true);
      // The new visit reads only once the save has landed.
      expect(calls.map((c) => c.method ?? "GET")).toEqual(["GET", "POST"]);
      await act(async () => { s.letGo(); });
      await settleRounds();
      expect([storeState!.saving, storeState!.config?.agent.preferences]).toEqual([false, "English"]);
    });
  });

  test("a save that needs a restart and lands while Settings is closed shows its reason on the next visit", async () => {
    const s = server("auto");
    await withFetch(s.handler, async () => {
      const first = mount(<SettingsConfigProvider><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      act(() => { void storeState!.savePatch({ agent: { preferences: "English" }, restart: true } as unknown as SettingsConfigUpdate, "Agent preferences").catch(() => {}); });
      await settleRounds();
      first.unmount();
      await act(async () => { s.letGo(); });
      await settleRounds();
      mount(<SettingsConfigProvider><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      expect(storeState!.restartReasons).toEqual(["Agent preferences"]);
    });
  });
});

describe("useSaveUnit", () => {
  test("derives form from config; edit flips dirty; revert flips it back", async () => {
    await withFetch(
      () => jsonResponse(mockConfig("auto")),
      async () => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe />
          </SettingsConfigProvider>
        );
        expect(unitState!.form).toBeNull();
        await settleRounds();
        expect(unitState!.form).toEqual({ preferences: "auto" });
        expect(unitState!.footer.dirty).toBe(false);

        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        expect(unitState!.form).toEqual({ preferences: "English" });
        expect(unitState!.footer.dirty).toBe(true);

        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "auto" }));
        });
        expect(unitState!.footer.dirty).toBe(false);
      }
    );
  });

  test("onSave saves the built patch, re-derives clean, sets justSaved, records restart reason", async () => {
    await withFetch(
      (call, index) => {
        if (index === 0) return jsonResponse(mockConfig("auto"));
        const body = JSON.parse(String(call.init?.body)) as { agent: { preferences: string } };
        return jsonResponse(mockConfig(body.agent.preferences, true));
      },
      async (fetchCalls) => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe restartReason="Analysis engine" />
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        expect(unitState!.footer.dirty).toBe(true);

        act(() => {
          unitState!.footer.onSave();
        });
        expect(unitState!.footer.saving).toBe(true);
        await settleRounds();
        expect(unitState!.footer.saving).toBe(false);
        expect(unitState!.footer.error).toBeNull();
        expect(unitState!.footer.dirty).toBe(false);
        expect(unitState!.footer.justSaved).toBe(true);
        expect(unitState!.form).toEqual({ preferences: "English" });
        expect(fetchCalls[1]!.init?.body).toBe(
          JSON.stringify({ agent: { preferences: "English" } })
        );
        expect(storeState!.config?.agent.preferences).toBe("English");
        expect(storeState!.restartReasons).toEqual(["Analysis engine"]);
      }
    );
  });

  test("buildPatch throw surfaces in footer.error and stays dirty", async () => {
    await withFetch(
      () => jsonResponse(mockConfig("auto")),
      async (fetchCalls) => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe
              buildPatch={() => {
                throw new Error("Port must be a number");
              }}
            />
          </SettingsConfigProvider>
        );
        await settleRounds();
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        act(() => {
          unitState!.footer.onSave();
        });
        await settleRounds();
        // A check that failed before anything was sent is its own sentence.
        expect(unitState!.footer.error).toEqual({ message: "Port must be a number" });
        expect(unitState!.footer.dirty).toBe(true);
        expect(unitState!.footer.saving).toBe(false);
        expect(unitState!.footer.justSaved).toBe(false);
        expect(fetchCalls.length).toBe(1); // no POST was attempted
      }
    );
  });

  test("save failure surfaces the server error and keeps the edit dirty", async () => {
    await withFetch(
      (_call, index) =>
        index === 0
          ? jsonResponse(mockConfig("auto"))
          : jsonResponse({ ok: false, error: "save exploded" }, 500),
      async () => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe />
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        act(() => {
          unitState!.footer.onSave();
        });
        await settleRounds();
        // A save that was sent and failed says so; the server's text goes below.
        expect(unitState!.footer.error).toEqual({ message: "Couldn't save.", detail: "save exploded" });
        expect(unitState!.footer.dirty).toBe(true);
        expect(unitState!.footer.saving).toBe(false);
        expect(unitState!.footer.justSaved).toBe(false);
        expect(unitState!.form).toEqual({ preferences: "English" }); // edit preserved
        expect(storeState!.config?.agent.preferences).toBe("auto"); // config untouched
      }
    );
  });

  test("rebase: clean unit re-derives on config change; dirty unit keeps edits judged against fresh config", async () => {
    const reloads = ["auto", "German", "French", "English"];
    await withFetch(
      (_call, index) => jsonResponse(mockConfig(reloads[index]!)),
      async () => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe />
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();

        // Clean → config change re-derives the form.
        await actAsync(() => storeState!.reload()); // → "German"
        await settleRounds();
        expect(unitState!.form).toEqual({ preferences: "German" });
        expect(unitState!.footer.dirty).toBe(false);

        // Dirty → config change keeps the edit; dirty judged against the fresh config.
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        expect(unitState!.footer.dirty).toBe(true);
        await actAsync(() => storeState!.reload()); // → "French"
        await settleRounds();
        expect(unitState!.form).toEqual({ preferences: "English" }); // edit kept
        expect(unitState!.footer.dirty).toBe(true); // "English" != fresh "French"

        // Fresh config that matches the kept edit → judged clean.
        await actAsync(() => storeState!.reload()); // → "English"
        await settleRounds();
        expect(unitState!.form).toEqual({ preferences: "English" });
        expect(unitState!.footer.dirty).toBe(false);
      }
    );
  });

  test("custom serialize ignores volatile fields when judging dirty", async () => {
    await withFetch(
      () => jsonResponse(mockConfig("auto")),
      async () => {
        render(
          <SettingsConfigProvider>
            <VolatileUnitProbe />
          </SettingsConfigProvider>
        );
        await settleRounds();
        act(() => {
          volatileState!.setForm((prev) => ({ ...prev, draftId: prev.draftId + 1 }));
        });
        expect(volatileState!.footer.dirty).toBe(false); // draftId is ignored by serialize
        act(() => {
          volatileState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        expect(volatileState!.footer.dirty).toBe(true);
      }
    );
  });
});

// A unit saved as it changes (Routing's chains): each edit is saved at once;
// edits made while one is on its way are saved after it, as they stand then,
// and no answer puts back an edit made after it was sent.
describe("useSaveUnit.saveNow", () => {
  /** A server that keeps what it is sent, trimmed; each save waits for `release`. */
  function heldServer() {
    const held: Array<() => void> = [];
    const bodies: string[] = [];
    return {
      held,
      bodies,
      fetch: (call: { init?: RequestInit }, index: number) => {
        if (index === 0) return jsonResponse(mockConfig("auto"));
        const body = JSON.parse(String(call.init?.body)) as { agent: { preferences: string } };
        bodies.push(body.agent.preferences);
        return new Promise<Response>((resolve) => { held.push(() => resolve(jsonResponse(mockConfig(body.agent.preferences.trim())))); });
      }
    };
  }
  const edit = (preferences: string) => act(() => { unitState!.saveNow((prev) => ({ ...prev, preferences })); });

  test("an edit is saved at once; the form lands clean, as the server keeps it, and says Saved", async () => {
    const server = heldServer();
    await withFetch(server.fetch, async () => {
      render(<SettingsConfigProvider><PreferencesUnitProbe /></SettingsConfigProvider>);
      await settleRounds();
      edit(" English ");
      expect(unitState!.form).toEqual({ preferences: " English " });
      expect(unitState!.footer.saving).toBe(true);
      await settleRounds();
      expect(server.bodies).toStrictEqual([" English "]);
      await act(async () => { server.held[0]!(); });
      await settleRounds();
      expect(unitState!.form).toEqual({ preferences: "English" });
      expect([unitState!.footer.dirty, unitState!.footer.saving, unitState!.footer.justSaved, unitState!.footer.error]).toEqual([false, false, true, null]);
    });
  });

  test("an edit made while a save is on its way is saved after it, and the first answer does not put the form back", async () => {
    const server = heldServer();
    await withFetch(server.fetch, async () => {
      render(<SettingsConfigProvider><PreferencesUnitProbe /></SettingsConfigProvider>);
      await settleRounds();
      edit("A");
      await settleRounds();
      edit("B");
      await settleRounds();
      expect(server.bodies).toStrictEqual(["A"]);
      await act(async () => { server.held[0]!(); });
      await settleRounds();
      // The answer for A is in; B stands and is on its way.
      expect(unitState!.form).toEqual({ preferences: "B" });
      expect(server.bodies).toStrictEqual(["A", "B"]);
      await act(async () => { server.held[1]!(); });
      await settleRounds();
      expect(unitState!.form).toEqual({ preferences: "B" });
      expect(unitState!.footer.dirty).toBe(false);
    });
  });

  test("an edit put back to the saved value while a save is on its way is not undone by that save's answer", async () => {
    const server = heldServer();
    await withFetch(server.fetch, async () => {
      render(<SettingsConfigProvider><PreferencesUnitProbe /></SettingsConfigProvider>);
      await settleRounds();
      edit("English");
      await settleRounds();
      edit("auto");
      await act(async () => { server.held[0]!(); });
      await settleRounds();
      expect(unitState!.form).toEqual({ preferences: "auto" });
      await act(async () => { server.held[1]!(); });
      await settleRounds();
      expect(server.bodies).toStrictEqual(["English", "auto"]);
      expect(unitState!.form).toEqual({ preferences: "auto" });
    });
  });

  test("edits made before and after the section is shown again go out in the order they were made", async () => {
    const server = heldServer();
    await withFetch(server.fetch, async () => {
      const view = mount(<SettingsConfigProvider><PreferencesUnitProbe /><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      edit("Low");
      await settleRounds();
      edit("Medium");
      await settleRounds();
      // Another tab, then back: the section mounts again while Low is on its way.
      view.rerender(<SettingsConfigProvider><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      view.rerender(<SettingsConfigProvider><PreferencesUnitProbe /><StoreProbe /></SettingsConfigProvider>);
      await settleRounds();
      edit("High");
      await settleRounds();
      for (let i = 0; i < 3; i++) {
        await act(async () => { server.held[i]!(); });
        await settleRounds();
      }
      expect(server.bodies).toStrictEqual(["Low", "Medium", "High"]);
      expect(storeState!.config?.agent.preferences).toBe("High");
      expect(unitState!.form).toEqual({ preferences: "High" });
    });
  });

  test("a change whose save fails right after the save before it landed stays, and onSave sends it", async () => {
    const bodies: string[] = [];
    let releaseFirst: () => void = () => {};
    await withFetch(
      (call, index) => {
        if (index === 0) return jsonResponse(mockConfig("auto"));
        const body = JSON.parse(String(call.init?.body)) as { agent: { preferences: string } };
        bodies.push(body.agent.preferences);
        if (bodies.length === 1) return new Promise<Response>((resolve) => { releaseFirst = () => resolve(jsonResponse(mockConfig("Low"))); });
        if (bodies.length === 2) return jsonResponse({ ok: false, error: "settings file is read-only" }, 500);
        return jsonResponse(mockConfig(body.agent.preferences));
      },
      async () => {
        render(<SettingsConfigProvider><PreferencesUnitProbe /></SettingsConfigProvider>);
        await settleRounds();
        edit("Low");
        await settleRounds();
        // Back to what is saved, while Low is on its way.
        edit("auto");
        await act(async () => { releaseFirst(); });
        await settleRounds();
        expect(bodies).toStrictEqual(["Low", "auto"]);
        expect(unitState!.form).toEqual({ preferences: "auto" });
        expect(unitState!.footer.error?.message).toBe("Couldn't save.");
        act(() => { unitState!.footer.onSave(); });
        await settleRounds();
        expect(bodies).toStrictEqual(["Low", "auto", "auto"]);
        expect(unitState!.form).toEqual({ preferences: "auto" });
      }
    );
  });

  test("a config that lands right after a save's answer, before a render, still rebases the form", async () => {
    let releaseFirst: () => void = () => {};
    await withFetch(
      (call, index) => {
        if (index === 0) return jsonResponse(mockConfig("auto"));
        const body = JSON.parse(String(call.init?.body)) as { agent: { preferences: string } };
        if (index === 1) return new Promise<Response>((resolve) => { releaseFirst = () => resolve(jsonResponse(mockConfig(body.agent.preferences))); });
        return jsonResponse(mockConfig(body.agent.preferences));
      },
      async () => {
        render(<SettingsConfigProvider><PreferencesUnitProbe /><StoreProbe /></SettingsConfigProvider>);
        await settleRounds();
        edit("X");
        await settleRounds();
        // Another section's save, queued behind it, answers at once.
        void storeState!.savePatch({ agent: { preferences: "Y" } });
        await act(async () => { releaseFirst(); });
        await settleRounds();
        expect(storeState!.config?.agent.preferences).toBe("Y");
        expect([unitState!.form, unitState!.footer.dirty]).toEqual([{ preferences: "Y" }, false]);
      }
    );
  });

  test("a save that fails keeps the edit and says why; onSave sends it again", async () => {
    let fail = true;
    const bodies: string[] = [];
    await withFetch(
      (call, index) => {
        if (index === 0) return jsonResponse(mockConfig("auto"));
        const body = JSON.parse(String(call.init?.body)) as { agent: { preferences: string } };
        bodies.push(body.agent.preferences);
        if (fail) return jsonResponse({ ok: false, error: "settings file is read-only" }, 500);
        return jsonResponse(mockConfig(body.agent.preferences));
      },
      async () => {
        render(<SettingsConfigProvider><PreferencesUnitProbe /></SettingsConfigProvider>);
        await settleRounds();
        edit("English");
        await settleRounds();
        expect(unitState!.form).toEqual({ preferences: "English" });
        expect(unitState!.footer.error?.message).toBe("Couldn't save.");
        expect(unitState!.footer.saving).toBe(false);
        fail = false;
        act(() => { unitState!.footer.onSave(); });
        await settleRounds();
        expect(bodies).toStrictEqual(["English", "English"]);
        expect([unitState!.form, unitState!.footer.error, unitState!.footer.dirty]).toEqual([{ preferences: "English" }, null, false]);
      }
    );
  });
});
