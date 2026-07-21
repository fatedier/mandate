import type { ReactNode } from "react";

import { PageHeader } from "@/shell/PageHeader";
import { cn } from "@/lib/utils";
import { MEMORY_VIEWS, type MemoryView } from "./memory-views";
import { RefreshButton } from "@/components/RefreshButton";

/**
 * Page frame shared by all three views: header, then the view switcher.
 *
 * Everything above the tabs is identical on every view, deliberately. When the
 * header carried a per-view subtitle and a button only one view supplied, it
 * was 32px tall on one tab and 25px on another — so the tab strip jumped under
 * the cursor that had just clicked it.
 */
export function MemoryShell({
  view,
  setView,
  refreshing,
  onRefresh,
  children
}: {
  view: MemoryView;
  setView: (next: MemoryView) => void;
  refreshing: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4 p-6">
      <PageHeader
        subtitle="What the agent has learned, and how it is holding up."
        trailing={
          <RefreshButton refreshing={refreshing} onRefresh={onRefresh} />
        }
      />
      <nav aria-label="Memory views" className="-mt-1 flex gap-0.5 border-b border-border-soft">
        {MEMORY_VIEWS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === view ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 border-transparent px-3 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground",
              item.id === view && "border-primary font-semibold text-foreground"
            )}
            onClick={() => setView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {children}
    </div>
  );
}
