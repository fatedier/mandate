import { useEffect } from "react";
import { LoadingLine, StateAction, StateMessage } from "@/components/ViewState";
import { findPane, terminalDisplayName, terminalWhere } from "@/lib/terminals-model";
import { LiveTerminal, TerminalClosedNotice } from "@/routes/terminal/LiveTerminal";
import type { TerminalTabMove } from "@/routes/terminal/TerminalHeader";
import { useStandalonePaneLookup } from "@/routes/terminal/useStandalonePaneLookup";
import { useTerminalsStore } from "@/store/terminals";
import { usePinToggle } from "./use-pin-toggle";

/** One pane's terminal on the Terminals page, or in the personal agent's
 *  panel, under the tab that names it: its controls go to the tab row, with
 *  where it is and Pin. `pid` is the one the address carries; a pane that
 *  now has another reads as closed. */
export function TerminalTab({ paneId, pid, onPid, shown = true, move }: {
  paneId: string;
  pid: number | null;
  /** False while kept hidden behind another tab (kept-terminals.ts). */
  shown?: boolean;
  /** An address without a pid is given the pane's at once: the id alone
   *  would follow tmux to whatever pane gets it next. */
  onPid?: (pid: number) => void;
  /** The Terminals page's Move left / Move right for its tab. */
  move?: TerminalTabMove;
}) {
  const lookup = useStandalonePaneLookup({ enabled: true, paneId, expectPid: pid });
  const sessions = useTerminalsStore((s) => s.sessions);
  const pane = lookup.pane;
  const knownPid = pid;
  const pin = usePinToggle(paneId, pid ?? 0);
  const foundPid = pid === null ? pane?.panePid ?? null : null;
  useEffect(() => { if (foundPid !== null) onPid?.(foundPid); }, [foundPid, onPid]);
  const frame = (children: React.ReactNode) => <div className="border-b border-border-soft bg-panel px-4 py-3">{children}</div>;

  if (lookup.status === "idle" || lookup.status === "loading" || foundPid !== null) return frame(<LoadingLine />);
  if (lookup.status === "error") {
    return frame(<StateMessage title="Couldn't load this pane" detail={lookup.error} action={<StateAction onClick={lookup.retry}>Retry</StateAction>} />);
  }
  if (lookup.status === "missing" || !pane) return <TerminalClosedNotice />;

  const listed = knownPid !== null ? findPane(sessions ?? [], paneId, knownPid) : null;
  const name = terminalDisplayName(listed?.pane ?? {
    currentCommand: pane.currentCommand ?? "", currentPath: pane.currentPath ?? "", title: null, metadata: pane.metadata
  });
  const where = terminalWhere({ currentCommand: pane.currentCommand ?? "", currentPath: pane.currentPath ?? "" }, pane.sessionName ?? "", pane.windowName ?? "");
  return (
    <LiveTerminal
      pane={pane}
      expectPid={knownPid}
      windowZoomed={Boolean(lookup.windowData?.windowZoomed)}
      header={{ titleText: name, path: where, pin: knownPid !== null ? pin : undefined, move }}
      shown={shown}
    />
  );
}
