import { expect, test } from "bun:test";

test("test setup blocks real network requests by default", async () => {
  await expect(fetch("https://example.com")).rejects.toThrow("Test attempted a real network request");
});
