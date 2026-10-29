import { cn } from "@/lib/utils";
import { rowStatus, type ToolRunRow } from "./tool-run-summary";
import type { DetailLayout } from "./tool-details/blocks";
import { BashDetails } from "./tool-details/BashDetails";
import { EditDetails } from "./tool-details/EditDetails";
import { ReadDetails, WriteDetails } from "./tool-details/FileDetails";
import { GenericDetails } from "./tool-details/GenericDetails";
import { MonitorDetails } from "./tool-details/MonitorDetails";
import { ReadPaneDetails, SendKeysDetails } from "./tool-details/PaneDetails";
import { WebFetchDetails, WebSearchDetails } from "./tool-details/WebDetails";

/** Tools whose calls read better as something other than arguments and an
 *  output — a command and what it printed, a diff, keys pressed, a screen, a
 *  file's lines, what a search found, a page read — get a view of their own;
 *  the rest share one. */
function DetailView({ row, layout }: { row: ToolRunRow; layout: DetailLayout }) {
  switch (row.call.toolName) {
    case "bash": return <BashDetails row={row} layout={layout} />;
    case "edit": return <EditDetails row={row} layout={layout} />;
    case "read": return <ReadDetails row={row} layout={layout} />;
    case "write": return <WriteDetails row={row} layout={layout} />;
    case "send_keys": return <SendKeysDetails row={row} layout={layout} />;
    case "read_pane": return <ReadPaneDetails row={row} layout={layout} />;
    case "monitor": return <MonitorDetails row={row} layout={layout} />;
    case "web_search": return <WebSearchDetails row={row} layout={layout} />;
    case "web_fetch": return <WebFetchDetails row={row} layout={layout} />;
    default: return <GenericDetails row={row} layout={layout} />;
  }
}

/** Everything one call carried: what it was for, its arguments, and what came
 *  back. The same body in the transcript and in the phone's sheet (`layout`). */
export function ToolCallDetails({ row, className, layout = "inline" }: {
  row: ToolRunRow;
  className?: string;
  layout?: DetailLayout;
}) {
  return (
    // Any word inside wraps, however long — a key the model chose, a path, a
    // token — so nothing pushes the phone's sheet sideways. Code keeps
    // `whitespace-pre`, which this does not touch, and scrolls in its block.
    <div data-slot="tool-details" data-layout={layout} className={cn("space-y-2 text-2xs [overflow-wrap:anywhere]", className)}>
      <DetailView row={row} layout={layout} />
      {rowStatus(row) === "running" && !row.result && (
        <div className="text-2xs italic text-muted-foreground">Running…</div>
      )}
    </div>
  );
}
