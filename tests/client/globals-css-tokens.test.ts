import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Guards the self-named token bridges in the @theme inline block
// (e.g. `--shadow-card: var(--shadow-card)`). Those only work because the
// same name is declared in the unlayered :root/[data-theme="dark"] scopes,
// which out-cascade Tailwind's @layer theme emission. If an author
// declaration is renamed or removed, the bridge turns circular and the
// utility silently drops — no build error, shadows just disappear.

const css = readFileSync(
  join(import.meta.dir, "..", "..", "src", "client", "styles", "globals.css"),
  "utf8"
);

function extractBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`"${marker}" not found in globals.css`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces after "${marker}"`);
}

function declaredNames(block: string): Set<string> {
  const names = new Set<string>();
  for (const match of block.matchAll(/--([\w-]+)\s*:/g)) names.add(match[1] ?? "");
  return names;
}

// Line-anchored markers: `[data-theme="dark"]` also appears inside the
// @custom-variant prelude, which would otherwise match first and capture
// the wrong block.
const themeBlock = extractBlock(css, "@theme inline");
const lightBlock = extractBlock(css, "\n:root {");
const darkBlock = extractBlock(css, '\n[data-theme="dark"] {');

const selfNamedBridges = [...themeBlock.matchAll(/--([\w-]+)\s*:\s*var\(--([\w-]+)\)/g)]
  .filter((match) => match[1] === match[2])
  .map((match) => match[1] ?? "");

describe("globals.css @theme bridges", () => {
  test("self-named bridges exist (parsing sanity)", () => {
    expect(selfNamedBridges.length).toBeGreaterThan(0);
  });

  test("every self-named bridge has author declarations in both themes", () => {
    const light = declaredNames(lightBlock);
    const dark = declaredNames(darkBlock);
    const missing = selfNamedBridges.filter((name) => !light.has(name) || !dark.has(name));
    expect(missing).toEqual([]);
  });

  test("every var() referenced in @theme resolves to a declaration", () => {
    const declaredSomewhere = new Set([
      ...declaredNames(lightBlock),
      ...declaredNames(darkBlock),
      ...declaredNames(themeBlock)
    ]);
    const unresolved = [...themeBlock.matchAll(/var\(--([\w-]+)\)/g)]
      .map((match) => match[1] ?? "")
      .filter((name) => !declaredSomewhere.has(name));
    expect(unresolved).toEqual([]);
  });
});

import { readFileSync as readFile } from "node:fs";

describe("desktop redesign tokens", () => {
  test("glow shadows are gone from the token layer and its call sites", () => {
    expect(css).not.toMatch(/--shadow-glow-/);
    expect(css).not.toMatch(/--status-glow/);
    for (const file of ["PaneDot.tsx", "StatusDot.tsx"]) {
      const source = readFile(
        join(import.meta.dir, "..", "..", "src", "client", "components", file),
        "utf8"
      );
      expect(source).not.toMatch(/glow/);
    }
  });

  test("the new tokens are declared in both themes and bridged", () => {
    const light = declaredNames(lightBlock);
    const dark = declaredNames(darkBlock);
    for (const name of ["user-bubble", "sel", "shadow-composer", "pill-mix", "code-bg"]) {
      expect([name, light.has(name)]).toEqual([name, true]);
      expect([name, dark.has(name)]).toEqual([name, true]);
    }
    expect(themeBlock).toContain("--color-user-bubble: var(--user-bubble)");
    expect(themeBlock).toContain("--color-sel: var(--sel)");
    expect(themeBlock).toContain("--shadow-composer: var(--shadow-composer)");
    expect(themeBlock).toContain("--color-code-bg: var(--code-bg)");
  });

  test("chat code blocks use the theme-aware code-bg, never the always-dark terminal-bg", () => {
    // `--terminal-bg` is #0a0c10 in both themes (it hosts terminals and
    // canvases). Chat code blocks pair their background with `text-foreground`,
    // which is dark in the light theme — on terminal-bg that is dark on dark.
    for (const rel of [
      ["components", "MarkdownView.tsx"],
      ["routes", "window", "chat", "ToolCallCard.tsx"]
    ]) {
      const source = readFile(join(import.meta.dir, "..", "..", "src", "client", ...rel), "utf8");
      expect([rel.join("/"), /bg-terminal-bg/.test(source)]).toEqual([rel.join("/"), false]);
    }
  });

  test("cards carry no shadow; the composer does", () => {
    expect(lightBlock).toMatch(/--shadow-card:\s*0 0 #0000;/);
    expect(darkBlock).toMatch(/--shadow-card:\s*0 0 #0000;/);
    expect(darkBlock).toMatch(/--shadow-primary-btn:\s*0 0 #0000;/);
    expect(darkBlock).toMatch(/--shadow-composer:\s*0 1px 2px/);
  });

  test("the UI font is the system stack, not Inter", () => {
    expect(themeBlock).toMatch(/--font-sans:\s*-apple-system, BlinkMacSystemFont, "SF Pro Text"/);
    expect(css).not.toContain('"Inter Variable"');
  });

  test("status pills exist for every tone the header can show", () => {
    for (const tone of ["amber", "red", "green", "blue", "cyan", "violet", "neutral"]) {
      expect(css).toContain(`.pill-${tone} {`);
    }
    expect(css).toMatch(/\.pill \{[^}]*height: 22px/);
  });
});
