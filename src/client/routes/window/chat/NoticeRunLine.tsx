import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatProvenance } from "./chatProvenance";
import { ChatProvenanceLine } from "./ChatProvenanceLine";

/** Notices from one thread that came one after another: one line, the
 *  latest's, with how many there are, which opens them in place. Opened,
 *  each of them is a row of the transcript under it (NoticeRunMember). */
export function NoticeRunHeader({ latest, count, open, onOpenChange }: {
  latest: ChatProvenance;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const toggle = (
    <button
      type="button"
      data-slot="notice-run-toggle"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
      // Next to the label, as the dot between a line's parts is.
      className="-ml-1.5 flex shrink-0 items-center gap-0.5 self-stretch rounded-xs whitespace-pre text-faint hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      {`· ${count} updates`}
      <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
    </button>
  );
  return (
    <div data-slot="notice-run" className="min-w-0">
      <ChatProvenanceLine provenance={latest} more={toggle} />
    </div>
  );
}

/** One notice of an open run, under its line: indented on the run's rule,
 *  close to the next (globals.css). */
export function NoticeRunMember({ provenance }: { provenance: ChatProvenance }) {
  return (
    <div data-slot="notice-run-member" className="ml-2 min-w-0 border-l border-border pl-5">
      <ChatProvenanceLine provenance={provenance} grouped />
    </div>
  );
}
