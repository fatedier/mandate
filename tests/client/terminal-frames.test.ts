import { expect, test } from "bun:test";
import { createTerminalFrameWriter } from "../../src/client/hooks/terminal/terminal-frames.js";

function writer(resetFirst: boolean) {
  const log: string[] = [];
  const write = createTerminalFrameWriter({
    resetFirst,
    reset: () => log.push("reset"),
    write: async (text) => { log.push(`write:${text}`); },
    onFrame: () => log.push("frame")
  });
  return { log, write };
}

test("a replacement socket resets the terminal once, right before its first frame", async () => {
  const { log, write } = writer(true);
  expect(log).toStrictEqual([]);
  await write("capture");
  await write(new TextEncoder().encode("live"));
  expect(log).toStrictEqual(["reset", "frame", "write:capture", "frame", "write:live"]);
});

test("the first connection never resets", async () => {
  const { log, write } = writer(false);
  await write("capture");
  expect(log).toStrictEqual(["frame", "write:capture"]);
});

test("an empty frame neither resets nor counts, so the old screen stays up", async () => {
  const { log, write } = writer(true);
  await write("");
  await write(new Uint8Array());
  expect(log).toStrictEqual([]);
  await write("capture");
  expect(log).toStrictEqual(["reset", "frame", "write:capture"]);
});

test("live bytes that arrive before any capture do not clear the old screen", async () => {
  // The server could not capture the pane and went straight to the pipe.
  // Clearing for a fragment would leave less on screen than the old view.
  const { log, write } = writer(true);
  await write(new TextEncoder().encode("live"));
  expect(log).toStrictEqual(["frame", "write:live"]);
  // A capture that does come later still replaces the screen, once.
  await write("capture");
  await write("refresh");
  expect(log).toStrictEqual(["frame", "write:live", "reset", "frame", "write:capture", "frame", "write:refresh"]);
});

test("a UTF-8 character split across binary frames is decoded whole", async () => {
  const { log, write } = writer(false);
  const bytes = new TextEncoder().encode("中");
  await write(bytes.slice(0, 1));
  await write(bytes.slice(1));
  expect(log.filter((l) => l.startsWith("write:"))).toStrictEqual(["write:中"]);
});

test("a text frame starts a fresh decoder, dropping a dangling partial sequence", async () => {
  const { log, write } = writer(false);
  await write(new TextEncoder().encode("中").slice(0, 1));
  await write("snapshot");
  await write(new TextEncoder().encode("ok"));
  expect(log.filter((l) => l.startsWith("write:"))).toStrictEqual(["write:snapshot", "write:ok"]);
});

test("Blob frames are decoded like binary frames", async () => {
  const { log, write } = writer(false);
  await write(new Blob([new TextEncoder().encode("blob")]));
  expect(log).toStrictEqual(["frame", "write:blob"]);
});
