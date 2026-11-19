import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, type Location } from "react-router";
import { AppShell } from "@/shell/AppShell";
import { CoveredRouteContext, HistoryLocationContext } from "@/lib/covered-route";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { ProjectsPage } from "@/routes/projects/ProjectsPage";
import { ProjectPage } from "@/routes/projects/ProjectPage";
import { HomePage } from "@/routes/home/HomePage";
import { SideChatPage } from "@/routes/side-chat/SideChatPage";

// Home is the landing route. Activity also loads eagerly so its summary request
// starts at mount instead of waiting for the lazy route's Suspense retry (~300ms).
// The remaining routes load on demand to keep the terminal emulator, markdown
// renderer and settings panes off the initial loading path.
const ThreadPage = lazy(() => import("@/routes/threads/ThreadPage").then((m) => ({ default: m.ThreadPage })));
const ThreadsListPage = lazy(() => import("@/routes/threads/ThreadsListPage").then((m) => ({ default: m.ThreadsListPage })));
const TerminalPage = lazy(() => import("@/routes/terminal/TerminalPage").then((m) => ({ default: m.TerminalPage })));
const DutyPage = lazy(() => import("@/routes/duty/DutyPage").then((m) => ({ default: m.DutyPage })));
const TasksPage = lazy(() => import("@/routes/task-board/TasksPage").then((m) => ({ default: m.TasksPage })));
const NotesPage = lazy(() => import("@/routes/sticky-notes/NotesPage").then((m) => ({ default: m.NotesPage })));
const CalendarPage = lazy(() => import("@/routes/calendar/CalendarPage").then((m) => ({ default: m.CalendarPage })));
const WindowDetailPage = lazy(() => import("@/routes/terminals/WindowDetailPage").then((m) => ({ default: m.WindowDetailPage })));
const SettingsPage = lazy(() => import("@/routes/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const CanvasPage = lazy(() => import("@/routes/canvas/CanvasPage").then((m) => ({ default: m.CanvasPage })));
const CanvasModal = lazy(() => import("@/routes/canvas/CanvasPage").then((m) => ({ default: m.CanvasModal })));
const FilePage = lazy(() => import("@/routes/files/FilePage").then((m) => ({ default: m.FilePage })));
const FileModal = lazy(() => import("@/routes/files/FilePage").then((m) => ({ default: m.FileModal })));
const MemoryPage = lazy(() => import("@/routes/memory/MemoryPage").then((m) => ({ default: m.MemoryPage })));

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}

function AppRoutes() {
  const location = useLocation();
  const state = location.state as { backgroundLocation?: Location } | null;
  const backgroundLocation = (location.pathname.startsWith("/canvas/") || location.pathname === "/file") && isRouterLocation(state?.backgroundLocation)
    ? state.backgroundLocation
    : null;

  return (
    <>
      {/* Under a canvas modal the page behind stays mounted and says so: its
          location is no longer the history's current entry. */}
      <HistoryLocationContext.Provider value={location}>
      <CoveredRouteContext.Provider value={backgroundLocation !== null}>
      {/* A new page also goes in APP_ROUTE_PATTERNS (lib/app-routes.ts):
          an agent's link to any other absolute path is a file. */}
      <Routes location={backgroundLocation ?? location}>
        {/* Embed route renders the canvas content alone — no AppShell —
            so worker views can iframe it inline without double-chrome.
            It needs its own boundary: it renders outside the shell, so it
            cannot use the one wrapping the shell's Outlet. */}
        <Route
          path="/canvas/:canvasId/embed"
          element={<Suspense fallback={null}><CanvasPage presentation="embed" /></Suspense>}
        />
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          {/* Drawn by the shell, which keeps it once opened (KeptPage). */}
          <Route path="/agent" element={null} />
          <Route path="/agent/side-chats/:threadId" element={<SideChatPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectSlug" element={<ProjectPage />} />
          <Route path="/threads" element={<ThreadsListPage />} />
          <Route path="/threads/:threadId" element={<ThreadPage />} />
          <Route path="/projects/:projectSlug/workers/:workerSlug/pane/:paneId" element={<TerminalPage />} />
          {/* Drawn by the shell, which keeps it running a while after it is
              left (KeptAlivePage). */}
          <Route path="/terminals" element={null} />
          <Route path="/terminals/pane/:paneId" element={null} />
          <Route path="/terminals/window/:windowId" element={<WindowDetailPage />} />
          <Route path="/duty" element={<DutyPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:taskId" element={<TasksPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/file" element={<FilePage />} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
      </CoveredRouteContext.Provider>
      </HistoryLocationContext.Provider>
      {backgroundLocation && (
        <Routes>
          {/* Also outside the shell's boundary — the modal renders over
              whatever route is behind it. */}
          <Route
            path="/canvas/:canvasId"
            element={<Suspense fallback={null}><CanvasModal /></Suspense>}
          />
          <Route path="/file" element={<Suspense fallback={null}><FileModal /></Suspense>} />
        </Routes>
      )}
    </>
  );
}

function isRouterLocation(value: unknown): value is Location {
  if (!value || typeof value !== "object") return false;
  const location = value as Partial<Location>;
  return typeof location.pathname === "string" &&
    typeof location.search === "string" &&
    typeof location.hash === "string";
}
