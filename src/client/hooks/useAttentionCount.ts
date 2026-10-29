import { useMemo } from "react";
import { useWaitingRows } from "@/hooks/useWaitingRows";
import { waitingSummary } from "@/lib/waiting-rows";

/** Everything that waits on you, for what opens Home (the sidebar's New
 *  thread row or collapsed pen, a phone's menu button and drawer row, the
 *  Dock): the length of the list Home shows; red when something failed or
 *  stopped, yellow when a question waits, the review colour otherwise.
 *  `withoutAgent`: the sidebar and the phone's menu leave out Your agent's
 *  own question, which its own row shows; the Dock counts everything. */
export function useHomeAttention(opts: { withoutAgent?: boolean } = {}): { count: number; urgent: boolean; failed: boolean } {
  const rows = useWaitingRows();
  const withoutAgent = opts.withoutAgent ?? false;
  return useMemo(() => waitingSummary(rows, { withoutAgent }), [rows, withoutAgent]);
}
