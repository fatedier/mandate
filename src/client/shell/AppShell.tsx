import { lazy, Suspense, useEffect, useRef } from "react";
import { Outlet } from "react-router";
import { ConfirmHost } from "@/components/ConfirmDialog";
import { Toaster } from "@/components/ui/sonner";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useScrollRestoration } from "@/hooks/useScrollRestoration";
import { useSectionTracking } from "@/hooks/useSectionTracking";
import { useSnapshotSubscription } from "@/hooks/useSnapshotSubscription";
import { useVoiceSession } from "@/hooks/useVoiceSession";
import { useRememberNonCanvasPath } from "@/lib/last-non-canvas-path";
import { useUIStore } from "@/store/ui";
import { applyTheme } from "@/lib/theme";
import { Sidebar } from "@/shell/Sidebar";
import { BannerToaster } from "@/shell/BannerToaster";
import { NoticeToaster } from "@/components/NoticeCard";
import { TopBar } from "@/shell/TopBar";
import { PaneHeader } from "@/shell/PaneHeader";
import { PaneHeaderSlotsProvider } from "@/shell/pane-header-slots";
import { TitlebarStrip } from "@/shell/TitlebarStrip";
import { BackendBanner } from "@/shell/BackendBanner";
import { DockBadge } from "@/shell/DockBadge";
import { NotificationsClient } from "@/shell/NotificationsClient";
import { ZoomBadge } from "@/shell/ZoomBadge";
import { Workspace } from "@/shell/Workspace";
import { KeptAlivePage } from "@/shell/KeptAlivePage";
import { KeptPage } from "@/shell/KeptPage";
import { TERMINALS_PAGE_KEPT_MS, TERMINALS_PAGE_PATHS } from "@/routes/terminals/kept-terminals";
import { PersonalAgentPage } from "@/routes/personal/PersonalAgentPage";
import { MobileVoiceStrip } from "@/routes/voice/MobileVoiceStrip";

const TerminalsPage = lazy(() => import("@/routes/terminals/TerminalsPage").then((m) => ({ default: m.TerminalsPage })));

export function AppShell() {
  const isMobile = useIsMobile();
  const scrollRef = useRef<HTMLElement | null>(null);
  const theme = useUIStore((s) => s.theme);
  // Sync theme to <html data-theme="…"> globally — used to live in the
  // settings General pane, which only mounts on /settings, so theme didn't track
  // on other routes after a setTheme + navigate-away.
  useEffect(() => applyTheme(theme), [theme]);
  useSnapshotSubscription();
  useRememberNonCanvasPath();
  useScrollRestoration(scrollRef);
  useSectionTracking();
  useVoiceSession();

  return (
    <PaneHeaderSlotsProvider>
    <div className="flex h-dvh w-full overflow-hidden">
      {!isMobile && <Sidebar />}
      {/* The column wrapper exists for the desktop shell's title strip above
          the workspace (the sidebar carries its own); in the browser the strip
          renders nothing and the wrapper is inert. */}
      <div className="flex min-w-0 min-h-0 flex-1 flex-col">
      {!isMobile && <TitlebarStrip />}
      <BackendBanner />
      <Workspace scrollRef={scrollRef}>
        {isMobile ? <TopBar /> : <PaneHeader />}
        {isMobile && <MobileVoiceStrip />}
        <main
          ref={scrollRef}
          // Relative: a page kept running hidden lies over the place pages take.
          className="relative flex-1 min-w-0 min-h-0 overflow-auto [scrollbar-gutter:stable] flex flex-col"
        >
          {/* The boundary sits inside the shell, not around the router: routes
              are lazy now, and suspending above this point would tear down the
              sidebar and top bar on every navigation. Only the content area
              waits. The fallback is deliberately empty — a spinner that shows
              for the ~20ms a local chunk takes reads as a flash of failure. */}
          {/* The Personal agent's page is kept once opened (its route
              draws nothing): hidden, not unmounted, while another shows. */}
          <Suspense fallback={null}>
            <KeptPage path="/agent"><PersonalAgentPage /></KeptPage>
          </Suspense>
          {/* The Terminals page runs on for a while once left (its routes
              draw nothing): its terminals stay connected for the way back. */}
          <Suspense fallback={null}>
            <KeptAlivePage paths={TERMINALS_PAGE_PATHS} keepMs={TERMINALS_PAGE_KEPT_MS}><TerminalsPage /></KeptAlivePage>
          </Suspense>
          <Suspense fallback={null}>
            <Outlet />
          </Suspense>
        </main>
      </Workspace>
      </div>
      <Toaster richColors position="top-center" />
      <BannerToaster />
      <NoticeToaster />
      <ZoomBadge />
      <DockBadge />
      <NotificationsClient />
      <ConfirmHost />
    </div>
    </PaneHeaderSlotsProvider>
  );
}
