import { matchPath } from "react-router";

/** Every page of the app: App.tsx's routes but its catch-all. A link to one
 *  of these is the app's; any other absolute path an agent links is a file
 *  (file-link.ts). A new page goes here too. */
export const APP_ROUTE_PATTERNS: readonly string[] = [
  "/home",
  "/agent",
  "/agent/side-chats/:threadId",
  "/projects",
  "/projects/:projectSlug",
  "/threads",
  "/threads/:threadId",
  "/projects/:projectSlug/workers/:workerSlug/pane/:paneId",
  "/terminals",
  "/terminals/pane/:paneId",
  "/terminals/window/:windowId",
  "/duty",
  "/tasks",
  "/tasks/:taskId",
  "/notes",
  "/calendar",
  "/activity",
  "/settings",
  "/canvas/:canvasId",
  "/canvas/:canvasId/embed",
  "/memory",
  "/file"
];

/** Whether a path is one of the app's pages, matched as a whole pattern:
 *  `/home` is, `/home/dev/notes.md` is not. */
export function isAppPage(pathname: string): boolean {
  return APP_ROUTE_PATTERNS.some((pattern) => matchPath({ path: pattern, end: true }, pathname) !== null);
}
