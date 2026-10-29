/** The canvas a canvas path (canvasPathOf's) names. */
export function canvasIdOfPath(path: string): string | null {
  return /^\/canvas\/([A-Za-z0-9_-]+)/.exec(path)?.[1] ?? null;
}

/** The path of this app's canvas that a link points at, or null: `/canvas/<id>`
 *  written by itself (what the canvas tools return, and what agents write) or
 *  behind the address of the page it is read on (`here`). Its query and
 *  fragment are kept. An address on another host is that host's, whatever its
 *  path; a canvas's embed view and anything deeper are not the canvas's page.
 *  An id is letters, digits, `-` and `_`: `/canvas/:canvasId`, written to
 *  describe the route, names no canvas. */
export function canvasPathOf(href: string | null | undefined, here: string): string | null {
  const raw = href?.trim();
  if (!raw) return null;
  // A path from the root or a full address: `canvas/x`, relative to wherever
  // the reader happens to be, is not one.
  if (!raw.startsWith("/") && !/^https?:\/\//i.test(raw)) return null;
  let page: URL;
  let url: URL;
  try {
    page = new URL(here);
    url = new URL(raw, page);
  } catch {
    return null;
  }
  // By scheme and host, not by `origin`: the desktop app's page is on a
  // scheme of its own, and every address on such a scheme has the origin
  // "null", whatever its host.
  if (url.protocol !== page.protocol || url.host !== page.host) return null;
  if (!/^\/canvas\/[A-Za-z0-9_-]+$/.test(url.pathname)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
