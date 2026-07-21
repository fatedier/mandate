import { expect, test } from "bun:test";
import {
  isCurrentProjectSessionName,
  projectSessionHashForDataDir,
  projectSessionNameForDataDir,
  resolveCollision,
  resolveProjectSessionNameCollision,
  sanitizeFeatureName
} from "../src/server/platform/naming/names.js";

const dataDir = "/tmp/mandate-prod";
const hash = projectSessionHashForDataDir(dataDir);

test("projectSessionNameForDataDir: prefix + project name + instance hash", () => {
  expect(projectSessionNameForDataDir("My Cool App", dataDir)).toBe(`md-my_cool_app-${hash}`);
  expect(projectSessionNameForDataDir("foo/bar", dataDir)).toBe(`md-foo_bar-${hash}`);
  expect(projectSessionNameForDataDir("UPPER", dataDir)).toBe(`md-upper-${hash}`);
  expect(projectSessionNameForDataDir("123", dataDir)).toBe(`md-123-${hash}`);
});

test("projectSessionNameForDataDir: trims and collapses runs of non-alnum", () => {
  expect(projectSessionNameForDataDir("  spaces   here  ", dataDir)).toBe(`md-spaces_here-${hash}`);
  expect(projectSessionNameForDataDir("a---b", dataDir)).toBe(`md-a_b-${hash}`);
});

test("projectSessionNameForDataDir: throws on empty / pure-symbol input", () => {
  expect(() => projectSessionNameForDataDir("", dataDir)).toThrow(/empty/);
  expect(() => projectSessionNameForDataDir("   ", dataDir)).toThrow(/empty/);
  expect(() => projectSessionNameForDataDir("---", dataDir)).toThrow(/empty/);
});

test("sanitizeFeatureName: same rules but no prefix", () => {
  expect(sanitizeFeatureName("auth rework")).toBe("auth_rework");
  expect(sanitizeFeatureName("UPPER")).toBe("upper");
});

test("resolveCollision: returns base when free", () => {
  const free = (name: string) => name === "md-foo";
  expect(resolveCollision("md-foo", (n) => !free(n))).toBe("md-foo");
});

test("resolveCollision: appends -2, -3 ... until free", () => {
  const taken = new Set(["md-foo", "md-foo-2"]);
  expect(resolveCollision("md-foo", (n) => taken.has(n))).toBe("md-foo-3");
});

test("resolveProjectSessionNameCollision: keeps instance hash at the end", () => {
  const taken = new Set([
    projectSessionNameForDataDir("foo", dataDir),
    projectSessionNameForDataDir("foo", dataDir, 2)
  ]);
  expect(resolveProjectSessionNameCollision("foo", (n) => taken.has(n), { dataDir }))
    .toBe(projectSessionNameForDataDir("foo", dataDir, 3));
});

test("isCurrentProjectSessionName: matches only the current data-dir hash", () => {
  const current = projectSessionNameForDataDir("foo", dataDir);
  const other = projectSessionNameForDataDir("foo", "/tmp/mandate-dev");
  expect(isCurrentProjectSessionName(current, { dataDir })).toBe(true);
  expect(isCurrentProjectSessionName(other, { dataDir })).toBe(false);
  expect(isCurrentProjectSessionName("md-foo", { dataDir })).toBe(false);
});
