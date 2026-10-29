import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { PAGE_STYLE_TOKENS, pageStyleCss } from "@/routes/global/page/page-style";

const ROOT = path.resolve(import.meta.dir, "../..");

function reader(values: Record<string, string>) {
  return (name: string) => values[name] ?? "";
}

test("the page's stylesheet carries the app's tokens as --mandate-* variables and styles the body with them", () => {
  const css = pageStyleCss(reader({
    "color-scheme": "dark",
    "--background": " #141416",
    "--foreground": "#ededf0",
    "--primary": "#7b84f6",
    "--font-sans": "-apple-system, \"SF Pro Text\", sans-serif",
    "--text-sm": "0.875rem"
  }));
  expect(css).toBe(
    ":root{color-scheme:dark;--mandate-bg:#141416;--mandate-fg:#ededf0;--mandate-link:#7b84f6;--mandate-font:-apple-system, \"SF Pro Text\", sans-serif;--mandate-size-body:0.875rem}" +
    "body{background:var(--mandate-bg);color:var(--mandate-fg);font-family:var(--mandate-font);font-size:var(--mandate-size-body);line-height:1.5}"
  );
});

test("a token that is unset or could break out of the stylesheet is left out, and so is what the body would take from it", () => {
  const css = pageStyleCss(reader({
    "color-scheme": "normal",
    "--background": "red}</style><script>",
    "--foreground": "#111;background:red",
    "--muted-foreground": "#555"
  }));
  expect(css).toBe(":root{--mandate-muted:#555}body{line-height:1.5}");
});

test("the agent-page skill names exactly the variables the page is given", () => {
  const skill = fs.readFileSync(path.join(ROOT, "src/server/modules/skills/builtins/agent-page/SKILL.md"), "utf8");
  const named = new Set(skill.match(/--mandate-[a-z-]+/g));
  expect([...named].sort()).toEqual(PAGE_STYLE_TOKENS.map(([name]) => name).sort());
});

test("each app token the page takes is one the app's stylesheet declares", () => {
  const globals = fs.readFileSync(path.join(ROOT, "src/client/styles/globals.css"), "utf8");
  const missing = PAGE_STYLE_TOKENS.filter(([, token]) => !globals.includes(`${token}:`));
  expect(missing).toEqual([]);
});
