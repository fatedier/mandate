import { afterEach, describe, expect, it, test } from "bun:test";
import { act } from "react";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { runCleanups } from "../helpers/cleanup.js";
import { mountAsync, settle } from "../helpers/mount.js";

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
    expect(written).toStrictEqual(["hello"]);
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
    expect(copied as string | null).toBe("fallback");
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

  describe("inside a dialog", () => {
    afterEach(runCleanups);

    // On a plain-HTTP origin a copy goes through a hidden textarea; a modal keeps
    // focus inside itself, so a textarea outside it never holds the selection.
    test("a copy made from inside a dialog over plain HTTP copies, and the focus comes back", async () => {
      await mountAsync(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Summary</DialogTitle>
            <DialogDescription>A code block</DialogDescription>
            <button type="button" data-slot="copy">Copy</button>
          </DialogContent>
        </Dialog>
      );
      await settle();
      const copy = document.querySelector('[data-slot="copy"]') as HTMLButtonElement;
      copy.focus();
      expect(document.activeElement === copy).toBe(true);
      let copied: string | null = null;
      await withPatched(window, "isSecureContext", false, () =>
        withPatched(document, "execCommand", (command: string) => {
          if (command !== "copy") return false;
          const held = document.activeElement;
          copied = held instanceof HTMLTextAreaElement ? held.value : null;
          return true;
        }, async () => {
          let ok = false;
          await act(async () => { ok = await copyTextToClipboard("bun run test"); });
          expect(ok).toBe(true);
        })
      );
      expect(copied as string | null).toBe("bun run test");
      expect(document.getElementsByTagName("textarea").length).toBe(0);
      expect(document.activeElement === copy).toBe(true);
    });
  });
});
