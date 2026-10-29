import { describe, expect, it } from "bun:test";
import { randomId } from "@/lib/random-id";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
  it("returns a UUID when crypto.randomUUID exists", () => {
    expect(randomId()).toMatch(UUID_SHAPE);
  });

  it("falls back to getRandomValues in insecure contexts", () => {
    const original = crypto.randomUUID;
    // Plain-HTTP LAN access hides randomUUID but keeps getRandomValues.
    (crypto as { randomUUID?: typeof crypto.randomUUID }).randomUUID = undefined;
    try {
      const a = randomId();
      const b = randomId();
      expect(a).toMatch(UUID_SHAPE);
      expect(b).toMatch(UUID_SHAPE);
      expect(a).not.toBe(b);
    } finally {
      crypto.randomUUID = original;
    }
  });
});
