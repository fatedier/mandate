import { describe, expect, it } from "bun:test";
import { randomId } from "@/lib/random-id";
import { onCleanup } from "../helpers/cleanup.js";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** crypto.randomUUID as `value` for this test. It is Crypto.prototype's: the
 *  own property set here is deleted afterwards, not left behind. */
function randomUUIDAs(value: unknown) {
  const own = Object.getOwnPropertyDescriptor(crypto, "randomUUID");
  Object.defineProperty(crypto, "randomUUID", { configurable: true, writable: true, value });
  onCleanup(() => {
    if (own) Object.defineProperty(crypto, "randomUUID", own);
    else delete (crypto as { randomUUID?: unknown }).randomUUID;
  });
}

describe("randomId", () => {
  it("returns crypto.randomUUID's id when it exists", () => {
    randomUUIDAs(() => "0f0e0d0c-0b0a-4908-8706-050403020100");
    expect(randomId()).toBe("0f0e0d0c-0b0a-4908-8706-050403020100");
  });

  it("falls back to getRandomValues in insecure contexts", () => {
    // Plain-HTTP LAN access hides randomUUID but keeps getRandomValues.
    randomUUIDAs(undefined);
    const a = randomId();
    const b = randomId();
    expect(a).toMatch(UUID_SHAPE);
    expect(b).toMatch(UUID_SHAPE);
    expect(a).not.toBe(b);
  });
});
