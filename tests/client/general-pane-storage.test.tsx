import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "@/lib/api-paths";
import { GeneralPane } from "@/routes/settings/GeneralPane";
import { SettingsConfigProvider } from "@/routes/settings/SettingsConfigProvider";
import type { SettingsConfigResponse } from "@/routes/settings/types";

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

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

type FetchCall = { url: string; init?: RequestInit };

/**
 * Stubs fetch for the duration of `run`, restoring the original in `finally`.
 * Every client test file in this repo shares one process, so a leaked stub
 * would silently disable tests/setup.ts's real-network guard for whatever
 * file runs next.
 */
async function withFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler({ url, init });
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

/** Only the fields GeneralPane's always-rendered AgentsBlock reads. */
function mockConfig(): SettingsConfigResponse {
  return {
    ok: true,
    restartRequired: false,
    agent: { preferences: "", compressionThresholdTokens: 200000, logRequests: "off" }
  } as unknown as SettingsConfigResponse;
}

function buttonsOf(scope: HTMLElement): HTMLButtonElement[] {
  return Array.from(scope.getElementsByTagName("button")) as unknown as HTMLButtonElement[];
}

function buttonLabelled(scope: HTMLElement, label: string): HTMLButtonElement | null {
  return buttonsOf(scope).find((el) => el.textContent === label) ?? null;
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
  await settle();
  return container!;
}

describe("GeneralPane storage row", () => {
  test("shows the current chat size and offers a cleanup action", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 229_000_000 });
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();

        // Positive assertions, not just "nothing forbidden is present": a pane
        // that rendered nothing at all would satisfy an absence check.
        expect(host.textContent).toContain("Storage");
        expect(host.textContent).toMatch(/218(\.\d)? MB|229 MB/);
        expect(Boolean(buttonLabelled(host, "Clean up now"))).toBe(true);
      }
    );
  });

  test("the button warns that agents pause, and for how long", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
        if (call.url === api.storageStatus) return jsonResponse({ ok: true, databaseBytes: 229_000_000 });
        throw new Error(`unexpected fetch: ${call.url}`);
      },
      async () => {
        const host = await mountGeneralPane();

        // The warning is the whole reason this is a foreground action, and the
        // number in it is a disclosure the user decides on: measured at 19.1 s
        // on the 527.7 MB production database, 10.1 s of it the truncation and
        // 9.0 s the VACUUM. Pinning only "pause" let a stale 15 s survive.
        expect(host.textContent).toContain("pauses agents for about 20 seconds");
      }
    );
  });

  test("a failed size lookup stops claiming it is still calculating", async () => {
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
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
        expect(host.textContent).toContain("database unavailable");
      }
    );
  });

  test("the cleanup POST sends a content type that forces a preflight", async () => {
    const headers: Array<string | undefined> = [];
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
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
        await settle();

        // The server returns 415 without it. A no-body, no-header POST is a CORS
        // simple request that any page the user visits could fire.
        expect(headers).toEqual(["application/json"]);
      }
    );
  });

  test("clicking posts to the cleanup endpoint exactly once", async () => {
    const calls: string[] = [];
    await withFetch(
      (call) => {
        if (call.url === api.settingsConfig) return jsonResponse(mockConfig());
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

        await settle();

        expect(calls).toEqual(["/api/storage/cleanup"]);
        expect(button!.disabled).toBe(false);
        // Refreshed from the response's bytesAfter (100 MB), not the stale
        // pre-cleanup figure.
        expect(host.textContent).toMatch(/95(\.\d)? MB|100 MB/);
      }
    );
  });
});
