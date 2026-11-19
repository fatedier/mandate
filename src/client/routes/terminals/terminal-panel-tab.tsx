import { useEffect } from "react";
import type { NavigateFunction } from "react-router";
import { SquareTerminal } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { terminalOfTab } from "@/lib/panel-tabs";
import { findPane, terminalDisplayName, terminalHref, terminalTooltip } from "@/lib/terminals-model";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { readTerminalsIfNeeded, useTerminalsStore } from "@/store/terminals";

const icon = <SquareTerminal aria-hidden className="size-3.5 shrink-0" />;

/** Reads the terminals once, if nothing on the page has yet: a panel tab's
 *  name and the menu's pinned list come from them. */
export function useTerminalsRead(): void {
  useEffect(() => { readTerminalsIfNeeded(); }, []);
}

/** A pane's terminal beside the personal agent: a panel tab on a desktop, the
 *  full-screen terminal on a phone (a phone's panel shows no tabs of its own). */
export function openTerminalBeside(paneId: string, pid: number, phone: boolean, navigate: NavigateFunction): void {
  if (phone) navigate(terminalHref(paneId, pid));
  else useAgentPageUi.getState().openTerminal(paneId, pid);
}

/** The terminal tabs among the panel's own, named as All names them. */
export function usePanelTerminalTabs(tabIds: readonly string[], active: string, close: (tabId: string) => void): {
  items: ReadonlyMap<string, PanelTabItem>;
  /** The terminal whose tab is in sight, or null. */
  activeTerminal: { paneId: string; pid: number } | null;
} {
  useTerminalsRead();
  const sessions = useTerminalsStore((s) => s.sessions);
  const items = new Map<string, PanelTabItem>();
  for (const id of tabIds) {
    const terminal = terminalOfTab(id);
    if (!terminal) continue;
    const hit = findPane(sessions ?? [], terminal.paneId, terminal.pid);
    items.set(id, {
      id,
      label: hit ? terminalDisplayName(hit.pane) : terminal.paneId,
      tooltip: hit ? terminalTooltip(hit) : undefined,
      icon,
      group: "Terminals",
      onClose: () => close(id),
      dataTerminalTab: terminal.paneId
    });
  }
  return { items, activeTerminal: items.has(active) ? terminalOfTab(active) : null };
}
