import { useState } from "react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatClockMinutes } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentPageSourceDto } from "@shared/api/agent-page";
import { formatDurationShort } from "@shared/duration-short";

/** A source's schedule and last run, in one line: "every 5m · ran 18:05 · ok". */
function sourceLine(source: AgentPageSourceDto): string {
  const every = `every ${formatDurationShort(source.everyMs)}`;
  if (source.paused) return `${every} · paused`;
  if (!source.lastRunAt) return `${every} · not run yet`;
  const at = formatClockMinutes(source.lastRunAt);
  return source.lastError ? `${every} · failed ${at} · ${source.lastError}` : `${every} · ran ${at} · ok`;
}

/** The page's own sources: each with its schedule, last run and command,
 *  to pause, resume or remove; and what is built in. */
export function SourcesMenu({ sources, onPause, onRemove }: {
  sources: AgentPageSourceDto[];
  onPause(name: string, paused: boolean): Promise<void>;
  onRemove(name: string): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const act = (work: Promise<void>) => { void work.catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Couldn't change the source")); };
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
          Sources · {sources.length}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(380px,calc(100vw-2rem))] p-1.5">
        <ul data-slot="page-sources" className="flex flex-col gap-0.5">
          {sources.map((source) => (
            <li key={source.name} data-source={source.name} className="flex items-center gap-2.5 rounded-sm px-2 py-2">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-xs font-semibold">{source.name}</span>
                <span className={cn("text-2xs", source.lastError && !source.paused ? "text-destructive" : "text-muted-foreground")}>{sourceLine(source)}</span>
                {/* What it runs: two lines at most, whole on hover. */}
                <span data-slot="source-command" title={source.run} className="line-clamp-2 break-all font-mono text-2xs text-faint">{source.run}</span>
              </span>
              <button
                type="button"
                onClick={() => act(onPause(source.name, !source.paused))}
                className="hit relative shrink-0 rounded-sm border border-border-soft px-2 py-1 text-2xs text-chrome hover:text-foreground"
              >
                {source.paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                onClick={() => act(onRemove(source.name))}
                className="hit relative shrink-0 rounded-sm border border-border-soft px-2 py-1 text-2xs text-chrome hover:text-foreground"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <p className="border-t border-border-soft px-2 pb-1 pt-2 text-2xs text-muted-foreground">
          Built in: threads, workers, what waits on you, token usage, canvases, answers
        </p>
      </PopoverContent>
    </Popover>
  );
}
