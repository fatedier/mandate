import { Suspense, lazy } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, type Location } from "react-router";
import { AppShell } from "@/shell/AppShell";
import { ActivityPage } from "@/routes/activity/ActivityPage";
import { ProjectsPage } from "@/routes/projects/ProjectsPage";

// Home is the landing route. Activity also loads eagerly so its summary request
// starts at mount instead of waiting for the lazy route's Suspense retry (~300ms).
// The remaining routes load on demand to keep the terminal emulator, markdown
// renderer and settings panes off the initial loading path.
const WindowPage = lazy(() => import("@/routes/window/WindowPage").then((m) => ({ default: m.WindowPage })));
const TerminalPage = lazy(() => import("@/routes/terminal/TerminalPage").then((m) => ({ default: m.TerminalPage })));
const SessionsPage = lazy(() => import("@/routes/sessions/SessionsPage").then((m) => ({ default: m.SessionsPage })));
const SessionDetailPage = lazy(() => import("@/routes/sessions/SessionDetailPage").then((m) => ({ default: m.SessionDetailPage })));
const WindowDetailPage = lazy(() => import("@/routes/sessions/WindowDetailPage").then((m) => ({ default: m.WindowDetailPage })));
const SettingsPage = lazy(() => import("@/routes/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const CanvasPage = lazy(() => import("@/routes/canvas/CanvasPage").then((m) => ({ default: m.CanvasPage })));
const CanvasModal = lazy(() => import("@/routes/canvas/CanvasPage").then((m) => ({ default: m.CanvasModal })));
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
  const backgroundLocation = location.pathname.startsWith("/canvas/") && isRouterLocation(state?.backgroundLocation)
    ? state.backgroundLocation
    : null;

  return (
    <>
      <Routes location={backgroundLocation ?? location}>
        {/* Embed route renders the canvas content alone — no AppShell —
            so feature pages can iframe it inline without double-chrome.
            It needs its own boundary: it renders outside the shell, so it
            cannot use the one wrapping the shell's Outlet. */}
        <Route
          path="/canvas/:canvasId/embed"
          element={<Suspense fallback={null}><CanvasPage presentation="embed" /></Suspense>}
        />
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectSlug/features/:featureSlug" element={<WindowPage />} />
          <Route path="/projects/:projectSlug/features/:featureSlug/pane/:paneId" element={<TerminalPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/sessions/:sessionName" element={<SessionDetailPage />} />
          <Route path="/sessions/:sessionName/windows/:windowName" element={<WindowDetailPage />} />
          <Route path="/sessions/:sessionName/windows/:windowName/pane/:paneId" element={<TerminalPage />} />
          <Route path="/activity" element={<ActivityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/canvas/:canvasId" element={<CanvasPage />} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Route>
      </Routes>
      {backgroundLocation && (
        <Routes>
          {/* Also outside the shell's boundary — the modal renders over
              whatever route is behind it. */}
          <Route
            path="/canvas/:canvasId"
            element={<Suspense fallback={null}><CanvasModal /></Suspense>}
          />
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
