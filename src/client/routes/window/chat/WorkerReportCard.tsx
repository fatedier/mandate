import { memo } from "react";
import { PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WORKER_REPORT_LABEL, type WorkerReport, type WorkerReportKey } from "@shared/worker-report";

const TONE: Record<WorkerReportKey, string> = {
  // A worker's question is its manager's first: amber, as the worker's own state.
  input: "bg-amber/15 text-amber",
  failed: "bg-red/15 text-red",
  done: "bg-green/15 text-green",
  blocked: "bg-amber/15 text-amber",
  stopped: "bg-sel text-chrome",
  // Not moving either, as a stopped one.
  silent: "bg-sel text-chrome"
};

/** A worker's report in its thread: who, what state,
 *  the one line, and Open in panel. Drawn whether or not the manager replied. */
function WorkerReportCardImpl({ report, onOpen }: {
  report: WorkerReport;
  onOpen?: (featureId: string) => void;
}) {
  return (
    // No clock on the card: the transcript's dividers show the time, and the
    // row's own shows on hover (RowFrame).
    <div data-slot="worker-report" data-key={report.key} className="my-2 rounded-lg border border-border-soft bg-panel px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs text-foreground">{report.featureName}</span>
        <span className="shrink-0 text-2xs text-faint">{report.projectName}</span>
        <span className={cn("shrink-0 rounded-sm px-1.5 py-px text-2xs font-medium", TONE[report.key])}>
          {WORKER_REPORT_LABEL[report.key]}
        </span>
      </div>
      {report.line && <p className="mt-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">{report.line}</p>}
      {onOpen && (
        <Button variant="ghost" size="sm" className="mt-1 -ml-2 h-7 text-xs" onClick={() => onOpen(report.featureId)}>
          <PanelRightOpen className="h-3.5 w-3.5" />
          Open in panel
        </Button>
      )}
    </div>
  );
}

export const WorkerReportCard = memo(WorkerReportCardImpl);
