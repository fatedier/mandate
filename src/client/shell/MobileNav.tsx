import { useState } from "react";
import { useLocation } from "react-router";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { navMain, navSystem, navSettings, type NavItem } from "@/shell/nav-config";
import { NavItemRow } from "@/shell/NavItemRow";
import { FeaturesNavSection } from "@/shell/FeaturesNavSection";
import { AttentionBadge } from "@/shell/AttentionBadge";
import { useAttentionCount } from "@/hooks/useAttentionCount";
import { getSectionUrl, isInSection } from "@/lib/section-memory";

const brandLogoSrc = "/brand/mandate-logo-panes.svg";

export function MobileNav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const attentionCount = useAttentionCount();

  const renderItem = (item: NavItem) => {
    const active = isInSection(pathname, item.to);
    const target = active ? item.to : getSectionUrl(item.to);
    const isHome = item.to === "/projects";
    return (
      <NavItemRow
        key={item.to}
        item={item}
        active={active}
        target={target}
        badgeCount={isHome ? attentionCount : undefined}
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
              the drawer. attentionCount is already computed here for the Home
              row. `relative` above is required: the floating variant positions
              absolutely.
              Unguarded on purpose. AttentionBadge returns null at <= 0, and
              that is the single definition of "nothing to show" — a second
              `> 0` here would not change a pixel, but it would mask the
              component's guard so that neither could be mutated alone. */}
          <AttentionBadge count={attentionCount} floating />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-3 flex flex-col">
        <SheetTitle className="flex items-center gap-2 text-sm font-semibold px-3 mt-1 mb-3">
          <img src={brandLogoSrc} alt="" className="h-7 w-7 shrink-0" />
          <span>Mandate</span>
        </SheetTitle>
        <nav className="flex flex-col gap-0.5 flex-1 min-h-0 overflow-y-auto">
          {/* One uninterrupted list of destinations — no heading, no group, no
              gap. See the note in Sidebar.tsx. */}
          <div className="flex flex-col gap-0.5">
            {navMain.map(renderItem)}
          </div>
          <div className="flex flex-col gap-0.5">
            {navSystem.map(renderItem)}
          </div>
          {/* Last, and taking the spare height, for the same reason as the
              desktop sidebar: it is the only block whose height varies, so
              anything below it would shift under the user. */}
          <FeaturesNavSection className="flex-1" onNavigate={() => setOpen(false)} />
          {renderItem(navSettings)}
        </nav>
      </SheetContent>
    </Sheet>
  );
}
