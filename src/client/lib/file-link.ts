import { isAppPage } from "./app-routes";

/** A file an agent linked, and the lines it points at. */
export interface FileTarget {
  path: string;
  line?: number;
  end?: number;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);

/** The file a link in an agent's text names, or null: an absolute path that
 *  is none of the app's pages, or a file:// address on this machine. `#L42`
 *  or `#L42-L60` names lines; so does a `:42` ending, which agents write out
 *  of habit. Any other fragment is dropped. */
export function fileTargetOf(href: string | null | undefined): FileTarget | null {
  const raw = href?.trim();
  if (!raw) return null;
  let pathPart: string;
  let hash: string;
  if (/^file:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (url.host !== "" && url.host !== "localhost") return null;
    pathPart = url.pathname;
    hash = url.hash;
  } else {
    if (!raw.startsWith("/") || raw.startsWith("//")) return null;
    const at = raw.indexOf("#");
    const beforeHash = at === -1 ? raw : raw.slice(0, at);
    hash = at === -1 ? "" : raw.slice(at);
    // A query belongs to a page (`/settings?tab=voice`), not to a file.
    const query = beforeHash.indexOf("?");
    pathPart = query === -1 ? beforeHash : beforeHash.slice(0, query);
    if (isAppPage(pathPart)) return null;
  }
  let path = decodePath(pathPart);
  const lines = /^#L(\d+)(?:-L?(\d+))?$/.exec(hash);
  let line = lines ? Number(lines[1]) : undefined;
  let end = lines?.[2] ? Number(lines[2]) : undefined;
  if (!lines) {
    const colon = /:(\d+)(?::\d+)?$/.exec(path);
    if (colon) {
      path = path.slice(0, colon.index);
      line = Number(colon[1]);
    }
  }
  if (!path.startsWith("/") || path === "/") return null;
  const target: FileTarget = { path };
  if (line !== undefined && line >= 1) {
    target.line = line;
    if (end !== undefined && end > line) target.end = end;
  }
  return target;
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The file's own page: `/file?path=…&line=…&end=…`. */
export function fileRoute(target: FileTarget): string {
  const query = new URLSearchParams({ path: target.path });
  if (target.line !== undefined) query.set("line", String(target.line));
  if (target.end !== undefined) query.set("end", String(target.end));
  return `/file?${query.toString()}`;
}

/** The file a `/file` page's query names, or null. */
export function fileTargetOfSearch(search: string): FileTarget | null {
  const query = new URLSearchParams(search);
  const path = query.get("path");
  if (!path || !path.startsWith("/")) return null;
  const target: FileTarget = { path };
  const line = Number(query.get("line"));
  const end = Number(query.get("end"));
  if (Number.isInteger(line) && line >= 1) {
    target.line = line;
    if (Number.isInteger(end) && end > line) target.end = end;
  }
  return target;
}

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 && IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/** A path's last part. */
export function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

/** A path relative to a folder, made absolute: `.` and `..` resolved; one
 *  already absolute is itself. */
export function resolveFilePath(folder: string, relative: string): string {
  const parts = (relative.startsWith("/") ? [] : folder.split("/")).concat(relative.split("/"));
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** Whether a link's address is relative: no scheme, not from the root, not
 *  a fragment alone. */
export function isRelativeAddress(href: string): boolean {
  return href !== "" && !href.startsWith("/") && !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href);
}
