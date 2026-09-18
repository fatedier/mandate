import { useSyncExternalStore } from "react";
import { useUIStore, type Theme } from "@/store/ui";

export type ResolvedTheme = "dark" | "light";

export const DARK_QUERY = "(prefers-color-scheme: dark)";

/** "system" follows the OS (or browser) preference; the two explicit values
 *  are themselves. */
export function resolveTheme(theme: Theme, prefersDark: boolean): ResolvedTheme {
  if (theme === "dark" || theme === "light") return theme;
  return prefersDark ? "dark" : "light";
}

function query(win: Window): MediaQueryList | null {
  return typeof win.matchMedia === "function" ? win.matchMedia(DARK_QUERY) : null;
}

/** Stamps `<html data-theme>` with the resolved theme and, for "system",
 *  keeps it in step with the OS. Returns a teardown. The stylesheet only
 *  knows "dark" and "light"; "system" never reaches the DOM. */
export function applyTheme(theme: Theme, doc: Document = document, win: Window = window): () => void {
  const mql = query(win);
  const paint = () => {
    doc.documentElement.dataset.theme = resolveTheme(theme, mql?.matches ?? false);
  };
  paint();
  if (theme !== "system" || !mql) return () => {};
  mql.addEventListener("change", paint);
  return () => mql.removeEventListener("change", paint);
}

function subscribeSystem(listener: () => void): () => void {
  const mql = typeof window !== "undefined" ? query(window) : null;
  if (!mql) return () => {};
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}

function systemPrefersDark(): boolean {
  const mql = typeof window !== "undefined" ? query(window) : null;
  return mql?.matches ?? false;
}

/** The theme as it renders right now — "dark" or "light", never "system".
 *  For components that hand the theme to something outside the stylesheet
 *  (the toaster, a Canvas iframe's srcdoc). */
export function useResolvedTheme(): ResolvedTheme {
  const theme = useUIStore((s) => s.theme);
  const prefersDark = useSyncExternalStore(subscribeSystem, systemPrefersDark, () => false);
  return resolveTheme(theme, prefersDark);
}
