import { useState } from "react";
import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WakeFailureContent } from "@shared/agent-message-types";
import { formatUserFacingError } from "@/lib/error-message";
import { formatClockMinutes, formatDateTimeTitle } from "@/lib/format";

/** A turn that ended in an error or was stopped, as a line where it stopped:
 *  sized as a tool row, not a box, and kept as history. `action` is given only
 *  for the newest failure with nothing run since — Retry runs the wake again
 *  after an error; after a stop (a repeated failing call, replies that kept
 *  being cut off at the output token limit) Continue
 *  asks it to go on. Narrow, the reason takes its own line under the verb. */
export function WakeFailureLine({ failure, at, action }: { failure: WakeFailureContent; at: string; action?: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const cont = failure.status !== "error";
  const head = failure.status === "error" ? "Failed" : "Stopped";
  const reason = failure.status === "stuck"
    ? failure.message ?? "The same call kept failing."
    : failure.status === "cut_off"
      ? failure.message ?? "Cut off at the output token limit."
      : formatUserFacingError(failure.message ?? "The turn ended in an error.");
  const run = async () => {
    setBusy(true);
    try {
      await action?.();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      data-slot="wake-failure"
      data-status={failure.status}
      className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
    >
      <CircleAlert aria-hidden className="size-3.5 shrink-0 text-red" />
      <span className="shrink-0 font-medium text-red">{head}</span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground @max-[34rem]:order-last @max-[34rem]:basis-full @max-[34rem]:whitespace-normal @max-[34rem]:pl-5"
        title={reason}
      >
        {reason}
      </span>
      <time dateTime={at} title={formatDateTimeTitle(at)} className="shrink-0 tabular-nums text-faint @max-[34rem]:ml-auto">
        {formatClockMinutes(at)}
      </time>
      {action && (
        <Button size="xs" variant="outline" disabled={busy} onClick={() => void run()} className="shrink-0">
          {cont ? "Continue" : "Retry"}
        </Button>
      )}
    </div>
  );
}
