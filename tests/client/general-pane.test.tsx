import { describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { api } from "@/lib/api-paths";
import { GeneralPane } from "@/routes/settings/GeneralPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@/routes/settings/types";
import { jsonResponse, withFetch } from "../helpers/fetch.js";
import { mount, settleRounds } from "../helpers/mount.js";

/**
 * Settings › General (GeneralPane), mounted behind its config provider with
 * fetch answered per test: Your agent's name, the storage row, and the token
 * fields of Agents.
 */

/** Only the fields GeneralPane's always-rendered AgentsBlock reads. */
function config(globalAgentName = "", compressionThresholdTokens = 200000): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    agent: { preferences: "", compressionThresholdTokens, logRequests: "off", globalAgentName }
  } as unknown as SettingsConfigResponse;
}

describe("Your agent's name", () => {
  // The name is typed over "Jarvis" and saved; a blank one saves as Mandate.
  const rows: Array<{ name: string; typed: string; saved: string }> = [
    { name: "Settings › General › Your agent shows the name and saves a new one", typed: "Friday", saved: "Friday" },
    { name: "a name cleared in Settings saves Mandate: after Start the guide never returns", typed: "  ", saved: "Mandate" }
  ];

  test.each(rows)("$name", async ({ typed, saved }) => {
    const posts: unknown[] = [];
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig && (call.init?.method ?? "GET") === "POST") {
          const body = JSON.parse(String(call.init!.body)) as { agent: { globalAgentName: string } };
          posts.push(body);
          return jsonResponse(config(body.agent.globalAgentName));
        }
        if (call.url === api.settingsConfig) return jsonResponse(config("Jarvis"));
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 1 });
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const { host } = mount(<SettingsConfigProvider><GeneralPane /></SettingsConfigProvider>);
        await settleRounds();
        const input = host.querySelector<HTMLInputElement>(`input[aria-label="Your agent's name"]`)!;
        expect(input.value).toBe("Jarvis");
        // One word for it everywhere a person meets it: "Your agent", as the sidebar says before it has a name.
        const titles = Array.from(host.querySelectorAll('[data-slot="section-title"]')).map((el) => el.textContent);
        expect([titles.includes("Your agent"), titles.includes("Global agent")]).toEqual([true, false]);
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!;
          setter.call(input, typed);
          input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        });
        const section = input.closest('[data-slot="settings-section"]')!;
        const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
        await act(async () => { save.click(); });
        await settleRounds();
        expect(posts).toStrictEqual([{ agent: { globalAgentName: saved } }]);
      }
    );
  });
});

describe("GeneralPane storage row", () => {
  let container: HTMLElement | null = null;

  function render(node: ReactNode): void {
    container = mount(node).host;
  }

  function buttonsOf(scope: HTMLElement): HTMLButtonElement[] {
    return Array.from(scope.getElementsByTagName("button")) as unknown as HTMLButtonElement[];
  }

  function buttonLabelled(scope: HTMLElement, label: string): HTMLButtonElement | null {
    return buttonsOf(scope).find((el) => el.textContent === label) ?? null;
  }

  /** The InlineError the row shows: its sentence and the small line below. */
  function inlineError(scope: HTMLElement): { message: string; detail: string | null } | null {
    const el = scope.querySelector('[data-slot="inline-error"]');
    if (!el) return null;
    return { message: el.querySelector("span")?.textContent ?? "", detail: el.querySelector("p")?.textContent ?? null };
  }

  function click(button: HTMLElement): void {
    act(() => {
      button.click();
    });
  }

  /** Renders GeneralPane behind its config provider and lets both GETs settle. */
  async function mountGeneralPane(): Promise<HTMLElement> {
    render(
      <SettingsConfigProvider>
        <GeneralPane />
      </SettingsConfigProvider>
    );
    await settleRounds();
    return container!;
  }

  test("the button warns that agents pause, and for how long", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(config());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 229_000_000 });
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();

        // The warning is the whole reason this is a foreground action, and the
        // number in it is a disclosure the user decides on: tens of seconds
        // on a large database, part of it the truncation and
        // part the VACUUM. Pinning only "pause" let a stale 15 s survive.
        expect(host.textContent).toContain("pauses agents for about 20 seconds");
      }
    );
  });

  test("a failed size lookup stops claiming it is still calculating", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(config());
        if (call.url === api.storageStatus) {
          return jsonResponse({ ok: false, error: "database unavailable" }, 503);
        }
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();

        // The GET is never retried, so "Calculating size…" beside an error hint
        // is a claim that stays wrong for as long as the pane is open.
        expect(host.textContent).toContain("Size unavailable.");
        expect(host.textContent).not.toContain("Calculating size");
        // Said as an InlineError: what failed, the server's text small below.
        expect(inlineError(host)).toEqual({ message: "Couldn't read the database size.", detail: "database unavailable" });
        // A block in the row's hint: never inside a <p>.
        expect(host.querySelector('p [data-slot="inline-error"]') === null).toBe(true);
      }
    );
  });

  test("a failed cleanup says so, with the server's text below, and keeps the size it knew", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(config());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 229_000_000 });
        if (call.url === api.storageCleanup) return jsonResponse({ ok: false, error: "database unavailable" }, 503);
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();
        expect(host.textContent).toContain("Storage");
        expect(inlineError(host)).toBeNull();
        click(buttonLabelled(host, "Clean up now")!);
        await settleRounds();
        expect(inlineError(host)).toEqual({ message: "Couldn't clean up the database.", detail: "database unavailable" });
        expect(host.textContent).toMatch(/218(\.\d)? MB|229 MB/);
      }
    );
  });

  test("the cleanup POST sends a content type that forces a preflight", async () => {
    const headers: Array<string | undefined> = [];
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(config());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 229_000_000 });
        if (call.url === api.storageCleanup) {
          headers.push(new Headers(call.init?.headers).get("content-type") ?? undefined);
          return jsonResponse({ ok: true, truncated: 1, bytesBefore: 2, bytesAfter: 1 });
        }
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();
        click(buttonLabelled(host, "Clean up now")!);
        await settleRounds();

        // The server returns 415 without it. A no-body, no-header POST is a CORS
        // simple request that any page the user visits could fire.
        expect(headers).toStrictEqual(["application/json"]);
      }
    );
  });

  test("clicking posts to the cleanup endpoint exactly once", async () => {
    const calls: string[] = [];
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(config());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 229_000_000 });
        if (call.url === api.storageCleanup) {
          calls.push(call.url);
          return jsonResponse({ ok: true, truncated: 12, bytesBefore: 229_000_000, bytesAfter: 100_000_000 });
        }
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();

        const button = buttonLabelled(host, "Clean up now");
        expect(Boolean(button)).toBe(true);
        click(button!);

        // Pending state fires before the POST resolves: disabled, and no
        // silent no-op label.
        expect(button!.disabled).toBe(true);
        expect(button!.textContent).toBe("Cleaning up…");

        await settleRounds();

        expect(calls).toStrictEqual(["/api/storage/cleanup"]);
        expect(button!.disabled).toBe(false);
        // Refreshed from the response's bytesAfter (100 MB), not the stale
        // pre-cleanup figure.
        expect(host.textContent).toMatch(/95(\.\d)? MB|100 MB/);
      }
    );
  });
});

/**
 * The token fields of Settings › General › Agents: a count reads
 * with thousands separators in the body font, like the "Default: 200,000"
 * beside it, and as plain digits while it is being edited.
 */
describe("token fields", () => {
  async function withPane(run: (host: HTMLElement, posts: Array<{ agent?: Record<string, unknown> }>) => Promise<void>) {
    const posts: Array<{ agent?: Record<string, unknown> }> = [];
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig && (call.init?.method ?? "GET") === "POST") {
          posts.push(JSON.parse(String(call.init!.body)));
          return jsonResponse(config("", 170000));
        }
        if (call.url === api.settingsConfig) return jsonResponse(config("", 170000));
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 1 });
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const { host } = mount(<SettingsConfigProvider><GeneralPane /></SettingsConfigProvider>);
        await settleRounds();
        await run(host, posts);
      }
    );
  }

  const field = (host: HTMLElement, id: string) => host.querySelector<HTMLInputElement>(`#${id}`)!;
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, value);
      input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
    });
  };
  const focus = (input: HTMLInputElement) => act(() => { input.focus(); });
  const blur = (input: HTMLInputElement) => act(() => { input.blur(); });

  test("a count reads with thousands separators in the body font, and as plain digits while it is edited", async () => {
    await withPane(async (host) => {
      const threshold = field(host, "compression-threshold");
      expect(threshold.value).toBe("170,000");
      // The only count left: the worker token budget's row is gone.
      expect(host.querySelector("#worker-token-budget") === null).toBe(true);
      expect(threshold.className.split(/\s+/)).not.toContain("font-mono");
      focus(threshold);
      expect(threshold.value).toBe("170000");
      blur(threshold);
      expect(threshold.value).toBe("170,000");
    });
  });

  test("a count typed with separators is accepted, shown grouped, and saved as a number", async () => {
    await withPane(async (host, posts) => {
      const threshold = field(host, "compression-threshold");
      focus(threshold);
      await type(threshold, "250,000");
      blur(threshold);
      expect(threshold.value).toBe("250,000");
      expect(host.querySelector("#threshold-error")!.textContent).toBe("");
      const section = threshold.closest('[data-slot="settings-section"]')!;
      const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
      expect(save.disabled).toBe(false);
      await act(async () => { save.click(); });
      await settleRounds();
      expect(posts[0]?.agent?.compressionThresholdTokens).toBe(250000);
    });
  });

  test("Reset is off once the value is the default, however it is written", async () => {
    await withPane(async (host) => {
      const threshold = field(host, "compression-threshold");
      const reset = host.querySelector<HTMLButtonElement>('[aria-label="Reset threshold to default"]')!;
      expect(reset.disabled).toBe(false);
      focus(threshold);
      await type(threshold, "200,000");
      expect(reset.disabled).toBe(true);
    });
  });

  test("the saved count typed back with separators is no edit: nothing waits to be saved", async () => {
    await withPane(async (host) => {
      const threshold = field(host, "compression-threshold");
      const section = threshold.closest('[data-slot="settings-section"]')!;
      // A clean section draws no Save at all.
      const save = () => [...section.querySelectorAll("button")].find((b) => b.textContent === "Save");
      expect(save() === undefined).toBe(true);
      focus(threshold);
      await type(threshold, "170,001");
      // A real edit does draw it: the probe can see the difference.
      expect(save() === undefined).toBe(false);
      await type(threshold, "170,000");
      blur(threshold);
      expect(save() === undefined).toBe(true);
    });
  });

  test("a count the field refuses stays as typed, grouped neither at rest nor on the way out", async () => {
    await withPane(async (host) => {
      const threshold = field(host, "compression-threshold");
      focus(threshold);
      // Below the threshold's 1,000-token minimum.
      await type(threshold, " 000,999 ");
      blur(threshold);
      expect(threshold.value).toBe(" 000,999 ");
      expect(host.querySelector("#threshold-error")!.textContent).toBe("Enter a whole number of at least 1,000 tokens.");
    });
  });

  // Swapping "170,000" for "170000" on focus dropped the selection the focus
  // came with: Tab selects the whole value, so typing should replace it, but the
  // swap put the caret at the end and typing appended (170000250000, which no
  // rule refuses). The selection comes across the swap.
  test("focus that selected the whole count still selects it, as digits", async () => {
    await withPane(async (host) => {
      const threshold = field(host, "compression-threshold");
      threshold.setSelectionRange(0, threshold.value.length);
      focus(threshold);
      expect(threshold.value).toBe("170000");
      expect([threshold.selectionStart, threshold.selectionEnd]).toEqual([0, 6]);
    });
  });

  test("a caret placed among the grouped digits stays after the same digit", async () => {
    await withPane(async (host) => {
      const threshold = field(host, "compression-threshold");
      // After "170," — three digits in.
      threshold.setSelectionRange(4, 4);
      focus(threshold);
      expect(threshold.value).toBe("170000");
      expect([threshold.selectionStart, threshold.selectionEnd]).toEqual([3, 3]);
    });
  });
});

// Idle compaction: a switch row, then while it is on one group with the
// minutes before expiry and the smallest context.
describe("idle compaction", () => {
  async function withPane(run: (host: HTMLElement, posts: Array<{ agent?: Record<string, unknown> }>) => Promise<void>) {
    const posts: Array<{ agent?: Record<string, unknown> }> = [];
    const answer = () => ({ ...config(), agent: { ...(config() as unknown as { agent: Record<string, unknown> }).agent, idleCompactionEnabled: true, idleCompactionLeadMinutes: 5, idleCompactionMinTokens: 200000 } });
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig && (call.init?.method ?? "GET") === "POST") {
          posts.push(JSON.parse(String(call.init!.body)));
          return jsonResponse(answer());
        }
        if (call.url === api.settingsConfig) return jsonResponse(answer());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 1 });
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const { host } = mount(<SettingsConfigProvider><GeneralPane /></SettingsConfigProvider>);
        await settleRounds();
        await run(host, posts);
      }
    );
  }

  test("the switch row, and the group of two numbers while it is on", async () => {
    await withPane(async (host, posts) => {
      expect(host.textContent).toContain("Compact idle threads");
      expect(host.textContent).toContain("Before a long conversation's prompt cache expires, summarize it, so the next message doesn't pay to write the whole history again.");
      expect(host.textContent).toContain("Idle compaction");
      expect(host.textContent).toContain("Minutes before the cache expires");
      expect(host.textContent).toContain("Each model's cache lifetime is set in Providers: Claude an hour, GPT 30 minutes by default.");
      expect(host.textContent).toContain("Smallest context to compact");
      expect(host.textContent).toContain("Shorter threads are left as they are.");
      const lead = host.querySelector<HTMLInputElement>('input[aria-label="Minutes before the cache expires"]')!;
      const min = host.querySelector<HTMLInputElement>('input[aria-label="Smallest context to compact"]')!;
      expect([lead.value, min.value]).toEqual(["5", "200,000"]);
      const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Compact idle threads"]')!;
      await act(async () => { toggle.click(); });
      expect(host.textContent).not.toContain("Minutes before the cache expires");
      const section = toggle.closest('[data-slot="settings-section"]')!;
      const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
      await act(async () => { save.click(); });
      await settleRounds();
      expect(posts.at(-1)?.agent).toMatchObject({ idleCompactionEnabled: false, idleCompactionLeadMinutes: 5, idleCompactionMinTokens: 200000 });
    });
  });

  test("switched off, a hidden value it would refuse keeps Save on and is not sent", async () => {
    await withPane(async (host, posts) => {
      const lead = host.querySelector<HTMLInputElement>('input[aria-label="Minutes before the cache expires"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lead), "value")!.set!.call(lead, "0");
        lead.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
      });
      const toggle = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Compact idle threads"]')!;
      await act(async () => { toggle.click(); });
      const section = toggle.closest('[data-slot="settings-section"]')!;
      const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
      expect(save.disabled).toBe(false);
      await act(async () => { save.click(); });
      await settleRounds();
      expect(posts.at(-1)?.agent).toMatchObject({ idleCompactionEnabled: false, idleCompactionMinTokens: 200000 });
      expect(Object.hasOwn(posts.at(-1)!.agent!, "idleCompactionLeadMinutes")).toBe(false);
    });
  });

  test("minutes out of range are said and keep Save off", async () => {
    await withPane(async (host) => {
      const lead = host.querySelector<HTMLInputElement>('input[aria-label="Minutes before the cache expires"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(lead), "value")!.set!.call(lead, "60");
        lead.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
      });
      expect(host.textContent).toContain("Enter whole minutes from 1 to 59.");
      const section = lead.closest('[data-slot="settings-section"]')!;
      const save = [...section.querySelectorAll("button")].find((b) => b.textContent === "Save")!;
      expect(save.disabled).toBe(true);
    });
  });
});
