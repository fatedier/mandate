import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** In the composer's place while messages are picked to share: how many are
 *  picked (or what to do with none), Cancel, and Share. */
export function ShareSelectionBar({ count, onCancel, onShare }: { count: number; onCancel: () => void; onShare: () => void }) {
  return (
    <div className="px-3 pb-3">
      <div data-slot="share-bar" className="mx-auto flex w-full max-w-[640px] items-center gap-2 rounded-xl border border-border bg-panel px-3 py-2 text-sm">
        <span className={cn("min-w-0 flex-1 truncate", count === 0 ? "text-muted-foreground" : "font-medium tabular-nums")}>
          {count === 0 ? "Select the messages to include" : `${count} selected`}
        </span>
        <Button size="xs" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button size="xs" data-slot="share-open" disabled={count === 0} onClick={onShare}>Share</Button>
      </div>
    </div>
  );
}
