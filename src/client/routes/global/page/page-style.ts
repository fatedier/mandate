import { useSyncExternalStore } from "react";

/**
 * The app's colors and fonts, handed to Your agent's page as `--mandate-*`
 * CSS variables. They are read from the app's own tokens as the current theme
 * paints them, so the page follows globals.css and the theme with no copy of
 * either here. The same stylesheet sets the page's background, text and font
 * with them; it comes before the page's own styles, so the page has the last
 * word.
 */

/** Each variable the page reads, and the app token it takes its value from. */
export const PAGE_STYLE_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ["--mandate-bg", "--background"],
  ["--mandate-panel", "--panel"],
  ["--mandate-fg", "--foreground"],
  ["--mandate-muted", "--muted-foreground"],
  ["--mandate-faint", "--faint"],
  ["--mandate-border", "--border"],
  ["--mandate-code-bg", "--code-bg"],
  ["--mandate-link", "--primary"],
  ["--mandate-blue", "--blue"],
  ["--mandate-green", "--green"],
  ["--mandate-amber", "--amber"],
  ["--mandate-red", "--red"],
  ["--mandate-violet", "--violet"],
  ["--mandate-font", "--font-sans"],
  ["--mandate-mono", "--font-mono"],
  ["--mandate-size-small", "--text-2xs"],
  ["--mandate-size-body", "--text-sm"],
  ["--mandate-size-title", "--text-base"]
];

/** What the page's body takes from the variables, when the variable is there. */
const BODY: ReadonlyArray<readonly [string, string]> = [
  ["background", "--mandate-bg"],
  ["color", "--mandate-fg"],
  ["font-family", "--mandate-font"],
  ["font-size", "--mandate-size-body"]
];

/** A value that cannot end the declaration, the rule or the style element. */
const SAFE_VALUE = /^[^<>{};]+$/;

/** The page's stylesheet for the theme the app paints now. `read` gives an
 *  app token's value, or a property's (`color-scheme`), "" when unset. */
export function pageStyleCss(read: (name: string) => string): string {
  const root: string[] = [];
  const scheme = read("color-scheme").trim();
  // Form controls and scrollbars drawn for the page's ground.
  if (scheme === "light" || scheme === "dark") root.push(`color-scheme:${scheme}`);
  const given = new Set<string>();
  for (const [name, token] of PAGE_STYLE_TOKENS) {
    const value = read(token).trim();
    if (!value || !SAFE_VALUE.test(value)) continue;
    root.push(`${name}:${value}`);
    given.add(name);
  }
  const body = BODY.filter(([, name]) => given.has(name)).map(([property, name]) => `${property}:var(${name})`);
  return `:root{${root.join(";")}}body{${[...body, "line-height:1.5"].join(";")}}`;
}

/** The stylesheet as the element the page's head carries; the page's bridge
 *  finds it by its attribute to take a new theme's. */
export function pageStyleElement(css: string): string {
  return `<style data-mandate-page-style>${css}</style>`;
}

function readAppToken(name: string): string {
  if (typeof document === "undefined") return "";
  return window.getComputedStyle(document.documentElement).getPropertyValue(name);
}

/** The app's theme lives in `<html data-theme>` (theme.ts applyTheme): the
 *  tokens change when it does. */
function subscribeAppTheme(listener: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function snapshot(): string {
  return pageStyleCss(readAppToken);
}

/** The page's stylesheet, read again each time the app's theme changes. */
export function usePageStyleCss(): string {
  return useSyncExternalStore(subscribeAppTheme, snapshot, snapshot);
}
