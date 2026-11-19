import { useEffect } from "react";
import { useNavigate } from "react-router";
import { Check, Plus, SquareTerminal } from "lucide-react";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useIsMobile } from "@/hooks/useIsMobile";
import { terminalTabId } from "@/lib/panel-tabs";
import { findPane, terminalDisplayName } from "@/lib/terminals-model";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { useTerminalsStore } from "@/store/terminals";
import { openTerminalBeside } from "./terminal-panel-tab";

const icon = <SquareTerminal aria-hidden className="size-3.5 shrink-0" />;

/** New terminal and the pinned terminals, for a menu of the personal agent's
 *  page: its panel's + and, on a phone, its ⋯. Mounted as the menu opens, it
 *  reads the terminals then: only the Terminals page reads them on a timer,
 *  and a pin whose pane closed since goes on that read. */
export function TerminalMenuItems() {
  useEffect(() => { void useTerminalsStore.getState().refresh(); }, []);
  const phone = useIsMobile();
  const navigate = useNavigate();
  const pins = useTerminalsStore((s) => s.pins);
  const sessions = useTerminalsStore((s) => s.sessions);
  const openTabs = useAgentPageUi((s) => s.tabs);
  const newTerminal = async () => {
    const shell = await useTerminalsStore.getState().openShell();
    if (shell) openTerminalBeside(shell.paneId, shell.pid, phone, navigate);
  };
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem data-slot="new-terminal" onSelect={() => { void newTerminal(); }}>
        <Plus aria-hidden className="size-3.5 text-chrome" />
        <span className="min-w-0 flex-1 truncate">New terminal</span>
      </DropdownMenuItem>
      {pins.length > 0 && <DropdownMenuLabel className="text-2xs font-medium text-faint">Terminals</DropdownMenuLabel>}
      {pins.map((pin) => {
        const hit = findPane(sessions ?? [], pin.paneId, pin.pid);
        const name = hit ? terminalDisplayName(hit.pane) : pin.paneId;
        return (
          <DropdownMenuItem key={pin.paneId} onSelect={() => openTerminalBeside(pin.paneId, pin.pid, phone, navigate)}>
            {icon}
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {!phone && openTabs.includes(terminalTabId(pin.paneId, pin.pid)) && <Check role="img" aria-label="Open" className="size-3.5 text-faint" />}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
