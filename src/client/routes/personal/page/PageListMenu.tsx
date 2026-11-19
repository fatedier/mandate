import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** One row: its name, its line, and what it runs (a source's command),
 *  two lines at most and whole on hover. */
export interface PageListItem {
  name: string;
  line: string;
  /** The line says it failed: in the error color. */
  failed: boolean;
  paused: boolean;
  detail?: string;
  /** Whole on hover over the row. */
  title?: string;
}

/** The page's own sources or scheduled updates, behind a button in its
 *  toolbar: each to pause, resume or remove. */
export function PageListMenu({ kind, label, items, onPause, onRemove, fallbackError, footer }: {
  kind: "source" | "update";
  label: string;
  items: PageListItem[];
  onPause(name: string, paused: boolean): Promise<void>;
  onRemove(name: string): Promise<void>;
  /** What a refused change says when the server gave no reason. */
  fallbackError: string;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const act = (work: Promise<void>) => { void work.catch((error: unknown) => toast.error(error instanceof Error ? error.message : fallbackError)); };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-expanded={open}
          className={cn(
            "hit relative h-7 shrink-0 rounded-sm border px-2 text-xs transition-colors",
            open ? "border-border bg-sel text-foreground" : "border-border-soft text-chrome hover:text-foreground"
          )}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-2rem))] p-1.5">
        <ul data-slot={kind === "source" ? "page-sources" : "page-updates"} className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.name} {...{ [`data-${kind}`]: item.name }} title={item.title} className="flex items-center gap-2.5 rounded-sm px-2 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-xs font-semibold">{item.name}</span>
                <span className={cn("text-2xs", item.failed && !item.paused ? "text-destructive" : "text-muted-foreground")}>{item.line}</span>
                {item.detail !== undefined && (
                  <span data-slot={`${kind}-command`} title={item.detail} className="line-clamp-2 break-all font-mono text-2xs text-faint">{item.detail}</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => act(onPause(item.name, !item.paused))}
                className="hit relative shrink-0 rounded-sm border border-border-soft px-2 py-1 text-2xs text-chrome hover:text-foreground"
              >
                {item.paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={() => act(onRemove(item.name))}
                className="hit relative shrink-0 rounded-sm border border-border-soft px-2 py-1 text-2xs text-chrome hover:text-foreground"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {footer}
      </PopoverContent>
    </Popover>
  );
}
