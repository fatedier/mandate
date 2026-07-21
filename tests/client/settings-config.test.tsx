import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "@/lib/api-paths";
import {
  useSaveUnit,
  useSettingsConfig,
  type SaveUnitState
} from "@/routes/settings/settings-config";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse, SettingsConfigUpdate } from "@/routes/settings/types";

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(node: ReactNode): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

/** Let in-flight promises resolve, zero-delay timers fire, and React flush the results. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    await act(async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function actAsync<T>(run: () => Promise<T>): Promise<T> {
  let result: T | undefined;
  await act(async () => {
    result = await run();
  });
  return result as T;
}

type FetchCall = { url: string; init?: RequestInit };

let fetchCalls: FetchCall[] = [];

async function withFetch(
  handler: (call: FetchCall, index: number) => Response | Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  fetchCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: FetchCall = { url, init };
    const index = fetchCalls.length;
    fetchCalls.push(call);
    return handler(call, index);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
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
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
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
      async () => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        expect(storeState!.loading).toBe(true);
        await settle();
        expect(fetchCalls.length).toBe(1);
        expect(fetchCalls[0]!.url).toBe(api.settingsConfig);
        expect(fetchCalls[0]!.init?.method ?? "GET").toBe("GET");
        expect(storeState!.loading).toBe(false);
        expect(storeState!.config).toBeNull();
        expect(storeState!.loadError).toBe("config unavailable");

        await actAsync(() => storeState!.reload());
        await settle();
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
      async () => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settle();
        await actAsync(() => storeState!.savePatch(patch));
        await settle();
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
        await settle();
        await actAsync(() => storeState!.savePatch({}, "Server settings"));
        await actAsync(() => storeState!.savePatch({}, "Server settings"));
        await actAsync(() => storeState!.savePatch({}, "Voice settings"));
        await actAsync(() => storeState!.savePatch({}, "Memory settings"));
        await actAsync(() => storeState!.savePatch({}));
        await settle();
        expect(storeState!.restartReasons).toEqual(["Server settings", "Voice settings"]);

        act(() => {
          storeState!.clearRestartReasons();
        });
        await settle();
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
      async () => {
        render(
          <SettingsConfigProvider>
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settle();
        expect(storeState!.config?.agent.preferences).toBe("auto");

        let staleReload!: Promise<void>;
        act(() => {
          staleReload = storeState!.reload(); // GET in flight, unresolved
        });
        await settle();
        expect(fetchCalls.length).toBe(2);

        await actAsync(() => storeState!.savePatch({ agent: { preferences: "English" } }));
        await settle();
        expect(storeState!.config?.agent.preferences).toBe("English");

        releaseStaleReload();
        await actAsync(async () => {
          await staleReload;
        });
        await settle();
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
        await settle();
        expect(storeState!.config).not.toBeNull();

        let thrown: Error | null = null;
        try {
          await actAsync(() => storeState!.savePatch({ server: { port: -1 } }, "Server settings"));
        } catch (err) {
          thrown = err as Error;
        }
        expect(thrown?.message).toBe("invalid port");
        await settle();
        expect(storeState!.config?.agent.preferences).toBe("auto");
        expect(storeState!.restartReasons).toEqual([]);
      }
    );
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
        await settle();
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
      async () => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe restartReason="Analysis engine" />
            <StoreProbe />
          </SettingsConfigProvider>
        );
        await settle();
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        expect(unitState!.footer.dirty).toBe(true);

        act(() => {
          unitState!.footer.onSave();
        });
        expect(unitState!.footer.saving).toBe(true);
        await settle();
        expect(unitState!.footer.saving).toBe(false);
        expect(unitState!.footer.error).toBe("");
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
      async () => {
        render(
          <SettingsConfigProvider>
            <PreferencesUnitProbe
              buildPatch={() => {
                throw new Error("Port must be a number");
              }}
            />
          </SettingsConfigProvider>
        );
        await settle();
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        act(() => {
          unitState!.footer.onSave();
        });
        await settle();
        expect(unitState!.footer.error).toBe("Port must be a number");
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
        await settle();
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        act(() => {
          unitState!.footer.onSave();
        });
        await settle();
        expect(unitState!.footer.error).toBe("save exploded");
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
        await settle();

        // Clean → config change re-derives the form.
        await actAsync(() => storeState!.reload()); // → "German"
        await settle();
        expect(unitState!.form).toEqual({ preferences: "German" });
        expect(unitState!.footer.dirty).toBe(false);

        // Dirty → config change keeps the edit; dirty judged against the fresh config.
        act(() => {
          unitState!.setForm((prev) => ({ ...prev, preferences: "English" }));
        });
        expect(unitState!.footer.dirty).toBe(true);
        await actAsync(() => storeState!.reload()); // → "French"
        await settle();
        expect(unitState!.form).toEqual({ preferences: "English" }); // edit kept
        expect(unitState!.footer.dirty).toBe(true); // "English" != fresh "French"

        // Fresh config that matches the kept edit → judged clean.
        await actAsync(() => storeState!.reload()); // → "English"
        await settle();
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
        await settle();
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
