import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { useUIStore } from "@/store/ui";
import { BackLink, LoadingLine, StateMessage } from "@/components/ViewState";
import { compactPath } from "@/lib/format";
import { useTerminalPaneTarget } from "./useTerminalPaneTarget";
import { PaneSwitcherSheet } from "./PaneSwitcherSheet";
import { LiveTerminal } from "./LiveTerminal";
import { paneHrefFor, terminalPlace } from "./pane-href";

export function TerminalPage() {
  const params = useParams<{
    projectSlug?: string;
    workerSlug?: string;
    paneId?: string;
  }>();
  const isMobile = useMediaQuery("(max-width: 760px)");
  // The shell's own breakpoint: below it the top bar's breadcrumb names the
  // page, above it the pane header does, and only there is a title claimed.
  const shellMobile = useIsMobile();

  const {
    project, worker, paneId, pane, windowData,
    titleText, sessionName, windowName, stillLoading
  } = useTerminalPaneTarget(params);
  const rememberPane = useUIStore((s) => s.rememberPane);
  useEffect(() => {
    if (!paneId || !sessionName || !windowName) return;
    rememberPane({ sessionName, paneId });
  }, [rememberPane, sessionName, windowName, paneId]);
  // Phone-only pane switcher (the header title opens it). Closed on every
  // route change so a pick that navigates never leaves a stale open sheet.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  useEffect(() => { setSwitcherOpen(false); }, [paneId]);
  // Desktop shows only a breadcrumb's last segment, so the page names whose
  // terminal it is itself, while it loads and after the pane is gone too.
  // Which pane stays in the bar below.
  const place = terminalPlace({ workerSlug: params.workerSlug, workerName: worker?.name, worker });
  const desktopTitle = shellMobile ? null : (
    <PaneHeaderTitle>
      <h1 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-sm">
        <Link to={place.backHref} className="min-w-0 truncate text-muted-foreground hover:text-foreground">{place.name}</Link>
        <span aria-hidden className="text-faint">/</span>
        <span className="shrink-0 font-semibold text-foreground">Terminal</span>
      </h1>
    </PaneHeaderTitle>
  );

  if (stillLoading || !pane || !windowData) {
    // On the panel's ground, not the terminal's: these read in both themes.
    return (
      <div className="flex flex-col h-full min-h-0 bg-terminal-bg">
        {desktopTitle}
        <div className="border-b border-border-soft bg-panel px-4 py-3">
          {stillLoading ? <LoadingLine /> : (
            <StateMessage title="Pane not found" action={<BackLink to={place.backHref}>{`Back to ${place.name}`}</BackLink>}>
              It was closed.
            </StateMessage>
          )}
        </div>
      </div>
    );
  }

  const path = pane ? (compactPath(pane.currentPath) || pane.currentPath || "") : "";
  const paneIndex = pane?.paneIndex ?? null;
  // Worker windows keep the worker route (breadcrumb stays project / worker /
  // pane); everything else opens on the Terminals page.
  const hrefFor = (s: string, w: string, p: string, pid: number) =>
    paneHrefFor({ project, sessionName: s, windowName: w, paneId: p, pid });
  return (
    <div className="flex flex-col h-full min-h-0 bg-terminal-bg">
      {desktopTitle}
      <LiveTerminal
        pane={pane}
        windowZoomed={Boolean(windowData?.windowZoomed)}
        header={{
          titleText,
          path,
          switcher: isMobile && sessionName && windowName
            ? { windowName, paneIndex, open: switcherOpen, onToggle: () => setSwitcherOpen((v) => !v) }
            : undefined
        }}
      >
        {isMobile && sessionName && (
          <PaneSwitcherSheet
            open={switcherOpen}
            onOpenChange={setSwitcherOpen}
            sessionName={sessionName}
            currentPaneId={paneId}
            hrefFor={hrefFor}
          />
        )}
      </LiveTerminal>
    </div>
  );
}
