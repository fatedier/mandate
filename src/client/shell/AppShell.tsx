import { Suspense, useEffect, useRef } from "react";
import {
  Outlet,
  useLocation,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To
} from "react-router";
import { setNavigate } from "@/routes/window/chat/ui-action-dispatcher";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { Toaster } from "@/components/ui/sonner";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useSectionTracking } from "@/hooks/useSectionTracking";
import { useSnapshotSubscription } from "@/hooks/useSnapshotSubscription";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { usePublishUiLocation } from "@/lib/ui-context";
import { useUIStore } from "@/store/ui";
import { Sidebar } from "@/shell/Sidebar";
import { BannerToaster } from "@/shell/BannerToaster";
import { ConnectionIndicator } from "@/shell/ConnectionIndicator";
import { TopBar } from "@/shell/TopBar";
import { TopBarActionsProvider } from "@/shell/topbar-actions";
import { Workspace } from "@/shell/Workspace";
import { MobileChatSheet } from "@/routes/window/chat/MobileChatSheet";
import { MobileVoicePill } from "@/routes/voice/MobileVoicePill";
import { WorkerCanvasCache } from "@/routes/window/WorkerCanvasCache";

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => {
    const navigateWithCanvasModal = ((to: To | number, options?: NavigateOptions) => {
      if (typeof to === "number") {
        navigate(to);
        return;
      }
      if (shouldOpenCanvasAsModal(to, options, location)) {
        navigate(to, {
          ...options,
          state: {
            ...objectState(options?.state),
            backgroundLocation: location
          }
        });
        return;
      }
      navigate(to, options);
    }) as NavigateFunction;
    setNavigate(navigateWithCanvasModal);
    return () => setNavigate(null);
  }, [navigate, location]);
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLElement | null>(null);
  const theme = useUIStore((s) => s.theme);
  // Sync theme to <html data-theme="…"> globally — used to live in the
  // settings General pane, which only mounts on /settings, so theme didn't track
  // on other routes after a setTheme + navigate-away.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useSnapshotSubscription();
  usePublishUiLocation();
  useScrollRestoration(scrollRef);
  useSectionTracking();
  useVoiceSession();

  return (
    <TopBarActionsProvider>
    <div className="flex h-dvh w-full overflow-hidden">
      {!isMobile && <Sidebar />}
      <Workspace scrollRef={scrollRef}>
        <TopBar />
        <main
          ref={scrollRef}
          className="flex-1 min-w-0 min-h-0 overflow-auto scrollbar-thin [scrollbar-gutter:stable] flex flex-col"
        >
          {/* The boundary sits inside the shell, not around the router: routes
              are lazy now, and suspending above this point would tear down the
              sidebar and top bar on every navigation. Only the content area
              waits. The fallback is deliberately empty — a spinner that shows
              for the ~20ms a local chunk takes reads as a flash of failure. */}
          <WorkerCanvasCache>
            <Suspense fallback={null}>
              <Outlet />
            </Suspense>
          </WorkerCanvasCache>
        </main>
      </Workspace>
      {isMobile && <MobileChatSheet />}
      {isMobile && <MobileVoicePill />}
      <Toaster richColors position="top-center" />
      <BannerToaster />
      <ConnectionIndicator />
      <ConfirmHost />
    </div>
    </TopBarActionsProvider>
  );
}

function shouldOpenCanvasAsModal(
  to: To,
  options: NavigateOptions | undefined,
  location: ReturnType<typeof useLocation>
): boolean {
  if (options?.replace) return false;
  if (location.pathname.startsWith("/canvas/")) return false;
  if (hasBackgroundLocation(options?.state)) return false;
  const pathname = typeof to === "string" ? to : to.pathname ?? "";
  return pathname.startsWith("/canvas/");
}

function objectState(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object") return {};
  return state as Record<string, unknown>;
}

function hasBackgroundLocation(state: unknown): boolean {
  return Boolean(objectState(state).backgroundLocation);
}
