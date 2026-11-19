import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Fold } from "@/components/Fold";
import { InlineError } from "@/components/ViewState";
import { MarkdownView } from "@/components/MarkdownView";
import { errorText } from "@shared/error-text";
import type { WorkerRecordDto } from "@shared/api/plans";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fetchWorkerRecord } from "@/store/worker-plans";

/**
 * The worker's task record on its Plan tab, live or archived: folded to when
 * it was last rewritten and its first line, opened in place to the whole
 * record. Read when the card shows, when it is opened, when the server says
 * the record was rewritten (extraction, as the worker's conversation is
 * compacted or archived) and when the event stream comes back (a rewrite
 * said while it was down is not said again). No record, no row.
 */
export function WorkRecordRow({ workerId }: { workerId: string }) {
  const [open, setOpen] = useState(false);
  // Each opening reads the record again; Retry reads it after a failure.
  const [reads, setReads] = useState(0);
  // Keyed by worker, so another worker's answer never stands.
  const [read, setRead] = useState<{ workerId: string; record: WorkerRecordDto | null; error: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    fetchWorkerRecord(workerId).then(
      (record) => { if (current) setRead({ workerId, record, error: null }); },
      (err: unknown) => { if (current) setRead((was) => ({ workerId, record: was?.workerId === workerId ? was.record : null, error: errorText(err) })); }
    );
    return () => { current = false; };
  }, [workerId, reads]);
  useEffect(() => {
    const again = () => setReads((n) => n + 1);
    const onRewrite = (event: Event) => {
      if ((event as CustomEvent<{ workerId?: string }>).detail?.workerId === workerId) again();
    };
    window.addEventListener("mandate:worker-record-updated", onRewrite);
    window.addEventListener("mandate:sse-open", again);
    return () => {
      window.removeEventListener("mandate:worker-record-updated", onRewrite);
      window.removeEventListener("mandate:sse-open", again);
    };
  }, [workerId]);
  const here = read?.workerId === workerId ? read : null;
  const retry = () => setReads((n) => n + 1);
  if (!here) return null;
  const failed = here.error != null && (
    <div data-slot="plan-work-record-error" className="px-2 pb-2">
      <InlineError detail={here.error} onRetry={retry}>Couldn't load the work record.</InlineError>
    </div>
  );
  if (!here.record) return failed || null;
  const record = here.record;
  const toggle = () => {
    if (!open) setReads((n) => n + 1);
    setOpen(!open);
  };
  return (
    <div data-slot="plan-work-record-row" className="-mx-2 flex flex-col">
      <button type="button" data-slot="plan-work-record" aria-expanded={open} onClick={toggle}
        className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-chrome transition-colors hover:bg-sel hover:text-foreground pointer-coarse:min-h-11">
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {`Work record · Updated ${formatRelativeTime(record.updatedAt)}`}
      </button>
      {!open && (
        <p data-slot="plan-work-record-first-line" title={record.content.split("\n")[0]} className="m-0 truncate px-2 pb-1.5 pl-6.5 text-sm text-muted-foreground">
          {record.content.split("\n")[0]}
        </p>
      )}
      <Fold open={open}>
        <div data-slot="plan-work-record-body" className="px-2 pb-2 pl-6.5 text-sm">
          {failed}
          <MarkdownView text={record.content} dense />
        </div>
      </Fold>
    </div>
  );
}
