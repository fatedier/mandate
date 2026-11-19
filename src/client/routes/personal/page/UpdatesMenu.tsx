import { formatClockMinutes } from "@/lib/format";
import type { AgentPageUpdateDto } from "@shared/api/agent-page";
import { PageListMenu } from "./PageListMenu";

/** An update's times and how it last went, in one line:
 *  "Daily 09:00 · next 09:00 · updated 08:00". */
function updateLine(update: AgentPageUpdateDto): string {
  if (update.paused) return `${update.whenText} · paused`;
  const head = update.nextRunAt ? `${update.whenText} · next ${formatClockMinutes(update.nextRunAt)}` : update.whenText;
  if (!update.lastRunAt || !update.lastOutcome) return `${head} · not run yet`;
  const at = formatClockMinutes(update.lastRunAt);
  if (update.lastOutcome === "failed") return `${head} · failed ${at}${update.lastError ? ` · ${update.lastError}` : ""}`;
  return `${head} · ${update.lastOutcome === "updated" ? "updated" : "nothing changed"} ${at}`;
}

/** The page's scheduled updates: each with its times and how it last went,
 *  what it asks on hover, to pause, resume or remove. */
export function UpdatesMenu({ updates, onPause, onRemove }: {
  updates: AgentPageUpdateDto[];
  onPause(name: string, paused: boolean): Promise<void>;
  onRemove(name: string): Promise<void>;
}) {
  return (
    <PageListMenu
      kind="update"
      label={`Updates · ${updates.length}`}
      items={updates.map((update) => ({ name: update.name, line: updateLine(update), failed: update.lastOutcome === "failed", paused: update.paused, title: update.task }))}
      onPause={onPause}
      onRemove={onRemove}
      fallbackError="Couldn't change the update"
    />
  );
}
