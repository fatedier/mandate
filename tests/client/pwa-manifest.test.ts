import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const html = readFileSync(join(root, "src", "client", "index.html"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "assets", "manifest.webmanifest"), "utf8")) as {
  name: string; short_name: string; start_url: string; scope: string; display: string;
  background_color: string; theme_color: string;
  icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
};
const css = readFileSync(join(root, "src", "client", "styles", "globals.css"), "utf8");

test("the page links the manifest, an Apple touch icon and a theme colour per scheme", () => {
  expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  expect(html).toContain('<link rel="apple-touch-icon" href="/pwa/apple-touch-icon.png" />');
  expect(html).toContain('<meta name="theme-color" content="#f5f5f7" media="(prefers-color-scheme: light)" />');
  expect(html).toContain('<meta name="theme-color" content="#1e1e21" media="(prefers-color-scheme: dark)" />');
  expect(html).toContain('<meta name="mobile-web-app-capable" content="yes" />');
});

test("the manifest describes a standalone app rooted at / with real icon files", () => {
  expect(manifest.name).toBe("Mandate");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  const sizes = manifest.icons.map((i) => i.sizes).sort();
  expect(sizes).toEqual(["192x192", "512x512", "512x512"]);
  expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  for (const icon of manifest.icons) {
    expect(icon.type).toBe("image/png");
    // /pwa/… is served from assets/ (vite's publicDir), so the file must exist there.
    expect(existsSync(join(root, "assets", icon.src))).toBe(true);
  }
  expect(existsSync(join(root, "assets", "pwa", "apple-touch-icon.png"))).toBe(true);
});

test("manifest colours are the stylesheet's dark page and panel tokens", () => {
  const dark = css.slice(css.indexOf('\n[data-theme="dark"] {'));
  const bg = dark.match(/--background:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase();
  const panel = dark.match(/--panel:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase();
  expect(manifest.background_color.toLowerCase()).toBe(bg);
  expect(manifest.theme_color.toLowerCase()).toBe(panel);
});
