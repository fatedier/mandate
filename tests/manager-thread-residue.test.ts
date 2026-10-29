import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sourceFiles } from "./helpers/source-files.js";

test("production code never looks up 'the' manager thread by scope", () => {
  const offenders = sourceFiles(path.resolve(import.meta.dir, "../src/server"), /\.ts$/)
    .filter((file) => /(getOrCreateThread|getThreadByScope)\(\s*"manager"/.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(process.cwd(), file));
  expect(offenders).toEqual([]);
});
