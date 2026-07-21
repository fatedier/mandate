import { afterEach, expect, test } from "bun:test";
import { ChangesDiffCache } from "@/routes/window/changes/changes-diff-cache";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("diff cache bounds retained patches and evicts the least recently viewed file", async () => {
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const path = new URL(String(input), "http://localhost").searchParams.get("path")!;
    requests.push(path);
    return Response.json({ path, patch: `@@ -1 +1 @@\n+${path}\n`, truncated: path === "file-0", binary: false });
  }) as typeof fetch;
  const cache = new ChangesDiffCache("worker", "head");
  try {
    const first = await cache.load("file-0");
    expect(first.truncated).toBe(true);
    for (let i = 1; i < 20; i++) await cache.load(`file-${i}`);
    expect(await cache.load("file-0")).toBe(first);
    await cache.load("file-20");
    expect(cache.get("file-0")).toBe(first);
    expect(cache.get("file-1")).toBeUndefined();
    expect(requests.length).toBe(21);
    await cache.load("file-1");
    expect(requests.length).toBe(22);
    expect(cache.get("file-2")).toBeUndefined();
    cache.dispose();
    expect(cache.get("file-0")).toBeUndefined();
    await expect(cache.load("file-0")).rejects.toThrow();
    expect(requests.length).toBe(22);
  } finally { cache.dispose(); }
});
