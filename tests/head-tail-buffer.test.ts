import { expect, test } from "bun:test";
import { HeadTailBuffer } from "../src/server/platform/process/head-tail-buffer.js";

const fill = (buffer: HeadTailBuffer, text: string, chunk: number) => {
  for (let i = 0; i < text.length; i += chunk) buffer.push(Buffer.from(text.slice(i, i + chunk)));
  return buffer;
};

test("output within the cap comes back whole, with nothing omitted", () => {
  const buffer = fill(new HeadTailBuffer(10), "0123456789", 3);
  expect(buffer.toString()).toBe("0123456789");
  expect(buffer.omittedBytes).toBe(0);
});

test("past the cap it keeps the first half and the last half, and says how much went between", () => {
  const text = `HEAD${"m".repeat(1000)}TAIL`;
  const buffer = fill(new HeadTailBuffer(10), text, 7);
  expect(buffer.toString()).toBe(`HEADm\n... ${text.length - 10} bytes omitted ...\nmTAIL`);
  expect(buffer.omittedBytes).toBe(text.length - 10);
});

test("where the chunks fall does not change what is kept", () => {
  const text = Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join("");
  const whole = fill(new HeadTailBuffer(64), text, text.length).toString();
  for (const size of [1, 3, 17, 64, 65, 1000]) expect([size, fill(new HeadTailBuffer(64), text, size).toString()]).toEqual([size, whole]);
});

test("an odd cap gives the tail the extra byte", () => {
  const buffer = fill(new HeadTailBuffer(5), "abcdefghij", 10);
  expect(buffer.toString()).toBe("ab\n... 5 bytes omitted ...\nhij");
});

test("memory stays at the cap however much is pushed", () => {
  const buffer = new HeadTailBuffer(1024);
  const chunk = Buffer.alloc(64 * 1024, 0x79);
  for (let i = 0; i < 2048; i++) buffer.push(chunk);
  expect(buffer.retainedBytes).toBe(1024);
  expect(buffer.omittedBytes).toBe(2048 * 64 * 1024 - 1024);
});

test("a larger chunk after many small ones trims the tail back to its half", () => {
  const buffer = new HeadTailBuffer(20);
  for (const ch of "abcdefghijklmnopqrstuvwxyz") buffer.push(Buffer.from(ch));
  buffer.push(Buffer.from("0123456"));
  expect(buffer.retainedBytes).toBe(20);
  expect(buffer.toString()).toBe("abcdefghij\n... 13 bytes omitted ...\nxyz0123456");
});

test("small chunks after a large one cost what they add, not a copy of the tail each", () => {
  const buffer = new HeadTailBuffer(1024 * 1024);
  buffer.push(Buffer.alloc(1024 * 1024, 0x61));
  const started = performance.now();
  for (let i = 0; i < 10_000; i++) buffer.push(Buffer.from("b"));
  expect(performance.now() - started).toBeLessThan(200);
  expect(buffer.retainedBytes).toBe(1024 * 1024);
  expect(buffer.toString().endsWith("b".repeat(10_000))).toBe(true);
});

test("empty chunks keep nothing", () => {
  const buffer = new HeadTailBuffer(1024);
  for (let i = 0; i < 100_000; i++) buffer.push(Buffer.alloc(0));
  buffer.push(Buffer.from("x"));
  expect(buffer.toString()).toBe("x");
  // Reached into on purpose: the byte counters cannot show entries that hold no bytes.
  expect((buffer as unknown as { head: unknown[] }).head.length).toBeLessThanOrEqual(1);
});
