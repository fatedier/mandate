import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { cutKeepingWhole, maybeSpoolToolResult } from "../src/server/modules/agent/tool-output-spool.js";
import { formatReadLines } from "../src/server/modules/agent/tools/read-file.js";
import { toolOutputDir } from "../src/server/platform/fs/resources.js";
import { withTempDataDir } from "./helpers/fixtures.js";
import { parseCut } from "./helpers/cut-line.js";

// One way to cut a message body: each place keeps its own length; what is
// cut off is saved whole, and one line says so and where.

test("a text at the length is kept whole and nothing is written", () => {
  const { restore } = withTempDataDir();
  try {
    const text = "a".repeat(4000);
    expect(cutKeepingWhole(text, 4000, { threadId: "thr_reader" })).toBe(text);
    expect(fs.existsSync(toolOutputDir({ owner: { kind: "global" }, threadId: "thr_reader" }))).toBe(false);
  } finally { restore(); }
});

test("one character over keeps the first ones, saves the whole, and names the file", () => {
  const { restore } = withTempDataDir();
  try {
    const text = `${"b".repeat(4000)}c`;
    const cut = cutKeepingWhole(text, 4000, { threadId: "thr_reader" });
    // The line comes first: nothing that cuts the text later can drop it.
    expect(cut.startsWith("[Cut: the first 4,000 of 4,001 characters. The whole text: ")).toBe(true);
    expect(cut.endsWith(`]\n\n${"b".repeat(4000)}`)).toBe(true);
    expect(parseCut(cut)).toEqual({ kept: "b".repeat(4000), first: 4000, of: 4001, whole: text });
    const file = /The whole text: ([^\n]+)\]\n/.exec(cut)![1]!;
    expect(path.dirname(file)).toBe(toolOutputDir({ owner: { kind: "global" }, threadId: "thr_reader" }));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The same text cut again names the same file: one copy, however often it is read.
    expect(cutKeepingWhole(text, 4000, { threadId: "thr_reader" })).toBe(cut);
    expect(fs.readdirSync(path.dirname(file))).toHaveLength(1);
  } finally { restore(); }
});

test("a project's reader keeps the whole under that project", () => {
  const { restore } = withTempDataDir();
  try {
    const cut = cutKeepingWhole("d".repeat(10), 5, { threadId: "thr_w", owner: { kind: "project", projectId: "proj_1" } });
    const file = /The whole text: ([^\n]+)\]\n/.exec(cut)![1]!;
    expect(path.dirname(file)).toBe(toolOutputDir({ owner: { kind: "project", projectId: "proj_1" }, threadId: "thr_w" }));
  } finally { restore(); }
});

test("a whole that cannot be written leaves the line's first sentence only", () => {
  const { restore } = withTempDataDir();
  try {
    const dir = toolOutputDir({ owner: { kind: "global" }, threadId: "thr_blocked" });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.writeFileSync(dir, "a file where the folder would be");
    expect(cutKeepingWhole("e".repeat(12_345), 4000, { threadId: "thr_blocked" }))
      .toBe(`[Cut: the first 4,000 of 12,345 characters.]\n\n${"e".repeat(4000)}`);
  } finally { restore(); }
});

test("a cut never splits a character written as two code units", () => {
  const { restore } = withTempDataDir();
  try {
    const cut = cutKeepingWhole(`${"f".repeat(3999)}😀tail`, 4000, { threadId: "thr_reader" });
    expect(parseCut(cut)!.kept).toBe("f".repeat(3999));
    expect(parseCut(cut)!.first).toBe(3999);
  } finally { restore(); }
});

test("a whole left half-written by a failed write is never named: the next cut writes it whole", () => {
  const { restore } = withTempDataDir();
  const text = "g".repeat(5000);
  const write = spyOn(fs, "writeFileSync").mockImplementationOnce(((file: fs.PathOrFileDescriptor) => {
    fs.appendFileSync(file as string, "g".repeat(100));
    throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
  }) as typeof fs.writeFileSync);
  try {
    expect(cutKeepingWhole(text, 4000, { threadId: "thr_full" })).toBe(`[Cut: the first 4,000 of 5,000 characters.]\n\n${"g".repeat(4000)}`);
    const dir = toolOutputDir({ owner: { kind: "global" }, threadId: "thr_full" });
    expect(fs.readdirSync(dir)).toEqual([]);
    write.mockRestore();
    expect(parseCut(cutKeepingWhole(text, 4000, { threadId: "thr_full" }))!.whole).toBe(text);
  } finally { write.mockRestore(); restore(); }
});

// Read shows a line's first 2,000 characters only. A long thread-reading
// result saved to a file keeps each text on one line of its JSON, so a line
// after the text would be lost there; first, it is not.
test("each cut's path survives a reading result saved to a file and read back with read", () => {
  const { dataDir, restore } = withTempDataDir();
  try {
    const messages = Array.from({ length: 10 }, (_, i) => ({ seq: i, text: cutKeepingWhole(`${i} ${"t".repeat(6000)}`, 4000, { threadId: "thr_reader" }) }));
    const block = maybeSpoolToolResult({ result: { messages }, toolName: "read_thread", toolCallId: "c1", threadId: "thr_reader", wakeId: "w1" }) as string;
    const saved = block.split("\n").find((line) => line.startsWith(dataDir))!;
    const read = formatReadLines(fs.readFileSync(saved, "utf8"), 1, 2000);
    const paths = [...read.matchAll(/The whole text: ([^\]\\]+)\]/g)].map((m) => m[1]!);
    expect(paths).toHaveLength(10);
    expect(paths.map((file) => fs.readFileSync(file, "utf8").slice(0, 2))).toEqual(messages.map((_, i) => `${i} `));
  } finally { restore(); }
});

// Retention deletes a file 30 days after its last write: a whole named again
// is fresh from then, or a text read again on day 29 would name a file gone
// the next day.
test("a whole named again counts as fresh from then", () => {
  const { restore } = withTempDataDir();
  try {
    const text = "h".repeat(5000);
    const first = cutKeepingWhole(text, 4000, { threadId: "thr_reader" });
    const file = /The whole text: ([^\n]+)\]\n/.exec(first)![1]!;
    const monthAgo = new Date(Date.now() - 29 * 86_400_000);
    fs.utimesSync(file, monthAgo, monthAgo);
    expect(cutKeepingWhole(text, 4000, { threadId: "thr_reader" })).toBe(first);
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000);
  } finally { restore(); }
});
