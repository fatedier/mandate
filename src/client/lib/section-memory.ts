// Per-session memory of the last URL visited within each top-level nav
// section. When the user clicks a nav item, we send them back to where
// they were within that section instead of dropping the deep route.
//
// Module-level Map: lifetime is the page load (no persist across refresh).
// Components read it during render via useLocation re-renders, so no
// subscription mechanism is needed.

const memory = new Map<string, string>();

export function rememberSection(sectionRoot: string, fullUrl: string): void {
  memory.set(sectionRoot, fullUrl);
}

export function getSectionUrl(sectionRoot: string): string {
  return memory.get(sectionRoot) ?? sectionRoot;
}

export function findSectionRoot(pathname: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    if (pathname === root || pathname.startsWith(root + "/")) return root;
  }
  return null;
}

export function isInSection(pathname: string, sectionRoot: string): boolean {
  return pathname === sectionRoot || pathname.startsWith(sectionRoot + "/");
}
