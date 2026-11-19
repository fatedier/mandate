import { formatClockMinutes } from "@/lib/format";
import type { AgentPageSourceDto } from "@shared/api/agent-page";
import { formatDurationShort } from "@shared/duration-short";
import { PageListMenu } from "./PageListMenu";

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
  return (
    <PageListMenu
      kind="source"
      label={`Sources · ${sources.length}`}
      items={sources.map((source) => ({ name: source.name, line: sourceLine(source), failed: source.lastError !== null, paused: source.paused, detail: source.run }))}
      onPause={onPause}
      onRemove={onRemove}
      fallbackError="Couldn't change the source"
      footer={
        <p className="border-t border-border-soft px-2 pb-1 pt-2 text-2xs text-muted-foreground">
          Built in: threads, workers, what waits on you, token usage, canvases, answers
        </p>
      }
    />
  );
}
