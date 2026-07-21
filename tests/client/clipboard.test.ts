import { describe, expect, it } from "bun:test";
import { copyTextToClipboard } from "@/lib/clipboard";

function withPatched<T>(target: object, key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  return run().finally(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

describe("copyTextToClipboard", () => {
  it("uses the async clipboard API in secure contexts", async () => {
    const written: string[] = [];
    await withPatched(window, "isSecureContext", true, () =>
      withPatched(navigator, "clipboard", { writeText: async (t: string) => { written.push(t); } }, async () => {
        expect(await copyTextToClipboard("hello")).toBe(true);
      })
    );
    expect(written).toEqual(["hello"]);
  });

  it("falls back to execCommand in insecure contexts", async () => {
    let copied: string | null = null;
    await withPatched(window, "isSecureContext", false, () =>
      withPatched(document, "execCommand", (command: string) => {
        if (command !== "copy") return false;
        copied = (document.activeElement as HTMLTextAreaElement | null)?.value ?? null;
        return true;
      }, async () => {
        expect(await copyTextToClipboard("fallback")).toBe(true);
      })
    );
    expect(copied).toBe("fallback");
    expect(document.getElementsByTagName("textarea").length).toBe(0);
  });

  it("reports failure when the copy command is rejected", async () => {
    await withPatched(window, "isSecureContext", false, () =>
      withPatched(document, "execCommand", () => false, async () => {
        expect(await copyTextToClipboard("nope")).toBe(false);
      })
    );
    expect(document.getElementsByTagName("textarea").length).toBe(0);
  });
});
