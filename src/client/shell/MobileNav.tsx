import { useState } from "react";
import { useLocation } from "react-router";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { navMain, navSystem, navSettings, type NavItem } from "@/shell/nav-config";
import { NavItemRow } from "@/shell/NavItemRow";
import { NewThreadRow } from "@/shell/NewThreadRow";
import { GlobalAgentRow } from "@/shell/GlobalAgentRow";
import { FullscreenToggle } from "@/shell/FullscreenToggle";
import { ThreadsNavSection } from "@/shell/ThreadsNavSection";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { useHomeAttention } from "@/hooks/useAttentionCount";
import { getSectionUrl, isInSection } from "@/lib/section-memory";

const brandLogoSrc = "/brand/mandate-logo-panes.svg";

export function MobileNav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const attention = useHomeAttention({ withoutAgent: true });

  const renderItem = (item: NavItem) => {
    const active = isInSection(pathname, item.to);
    const target = active ? item.to : getSectionUrl(item.to);
    return (
      <NavItemRow
        key={item.to}
        item={item}
        active={active}
        target={target}
        onNavigate={() => setOpen(false)}
      />
    );
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Open navigation"
          className="relative text-muted-foreground hover:text-foreground"
        >
          <Menu className="h-5 w-5" />
          {/* Desktop reports the count even when the sidebar is collapsed; a
              phone had no equivalent, so nothing wanted you until you opened
              the drawer. The count is already computed here for the Home
              row. `relative` above is required: the floating variant positions
              absolutely.
              Unguarded on purpose. AttentionBadge returns null at <= 0, and
              that is the single definition of "nothing to show" — a second
              `> 0` here would not change a pixel, but it would mask the
              component's guard so that neither could be mutated alone. */}
          <AttentionBadge count={attention.count} urgent={attention.urgent} failed={attention.failed} floating />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-3 flex flex-col">
        <SheetTitle className="flex items-center gap-2 text-sm font-semibold px-3 mt-1 mb-3">
          <img src={brandLogoSrc} alt="" className="h-7 w-7 shrink-0" />
          <span>Mandate</span>
        </SheetTitle>
        {/* Full screen beside the close button: the browser's own, so the
            address bar goes without installing anything. 52px from the edge
            so its touch area meets the close button's (centred 24px in, 44px
            wide) without overlap. */}
        <FullscreenToggle size="icon-sm" onToggle={() => setOpen(false)} className="absolute top-2 right-[52px] text-muted-foreground" />
        <nav data-slot="app-nav" className="flex flex-col flex-1 min-h-0">
          <div className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto">
            {/* One uninterrupted list of destinations — no heading, no group, no
                gap. See the note in Sidebar.tsx. */}
            <div className="flex flex-col gap-0.5">
              {/* The open drawer covers the menu button's count: it sits on
                  the row that opens Home, which lists what waits. */}
              <GlobalAgentRow current={pathname === "/agent"} onNavigate={() => setOpen(false)} />
              <NewThreadRow current={pathname === "/home"} waiting={attention} onNavigate={() => setOpen(false)} />
              {navMain.map(renderItem)}
            </div>
            <div className="flex flex-col gap-0.5">
              {navSystem.map(renderItem)}
            </div>
            {/* Threads last, scrolling with the menu as one, as on the desktop
                sidebar. No workers (see Sidebar.tsx). */}
            <ThreadsNavSection onNavigate={() => setOpen(false)} />
          </div>
          {/* Under the scroller, not in it, so Settings anchors the bottom as
              on the desktop sidebar: in it, a long thread list pushed it below
              the fold. */}
          <div className="shrink-0 border-t border-border-soft pt-2 mt-1">
            {renderItem(navSettings)}
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
