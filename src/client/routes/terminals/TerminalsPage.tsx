import { useCallback, useContext, useEffect, useRef } from "react";
import { arrayMove } from "@dnd-kit/sortable";
import { LayoutGrid, Plus, SquareTerminal } from "lucide-react";
import { useMatch, useNavigate, useSearchParams } from "react-router";
import { PanelTabRow, type PanelTabItem } from "@/components/PanelTabRow";
import { Button } from "@/components/ui/button";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PageShownContext } from "@/lib/page-shown";
import { cn } from "@/lib/utils";
import { PaneHeaderActions, PaneHeaderTitle } from "@/shell/pane-header-slots";
import { TerminalControlsSlot, TerminalControlsSlotProvider } from "@/routes/terminal/terminal-controls-slot";
import type { TerminalTabMove } from "@/routes/terminal/TerminalHeader";
import { findPane, findPaneById, terminalDisplayName, terminalHref, terminalTooltip } from "@/lib/terminals-model";
import { useTerminalsPolling, useTerminalsStore } from "@/store/terminals";
import { useTerminalTabsStore } from "@/store/terminal-tabs";
import type { SessionDto } from "@shared/api-contracts";
import { AllTerminals } from "./AllTerminals";
import { keptTerminalLimit, useKeptTerminals } from "./kept-terminals";
import { TerminalTab } from "./TerminalTab";

const tabId = (paneId: string, pid: number | null) => `${paneId}:${pid ?? ""}`;
/** A tab's pane and pid (none for an address not looked up yet). */
const tabPane = (id: string) => {
  const at = id.lastIndexOf(":");
  const pid = Number(id.slice(at + 1));
  return { paneId: id.slice(0, at), pid: pid > 0 ? pid : null };
};
const icon = <SquareTerminal aria-hidden className="size-3.5 shrink-0" />;

/** A pane as its tab names it: as All does; while the list lacks it, the
 *  name it last had, else its id. On hover with where it is. */
function tabText(sessions: SessionDto[] | null, paneId: string, pid: number | null, kept?: string): { label: string; tooltip?: string } {
  const hit = pid !== null ? findPane(sessions ?? [], paneId, pid) : findPaneById(sessions ?? [], paneId);
  return hit ? { label: terminalDisplayName(hit.pane), tooltip: terminalTooltip(hit) } : { label: kept ?? paneId };
}

/** Terminals: All (every tmux session), then the panes the user pinned, then
 *  every other pane opened here, each kept as a tab (in this browser) until
 *  its × closes it, as a browser's tabs are. A tab is dragged (or moved from
 *  ⋯) among its own kind: the pins' order is the server's, shared by every
 *  device; the open tabs' is this browser's. */
export function TerminalsPage() {
  // Kept running hidden after another page opened (KeptAlivePage): its
  // terminals stay connected, none of them shown, and it reads nothing.
  const pageShown = useContext(PageShownContext);
  useTerminalsPolling(pageShown);
  const phone = useIsMobile();
  const navigate = useNavigate();
  // From the address, not the route: the shell draws the page (KeptAlivePage).
  const paneId = useMatch("/terminals/pane/:paneId")?.params.paneId ?? null;
  const [search] = useSearchParams();
  const pidParam = Number(search.get("pid"));
  const pid = Number.isInteger(pidParam) && pidParam > 0 ? pidParam : null;
  const sessions = useTerminalsStore((s) => s.sessions);
  const pins = useTerminalsStore((s) => s.pins);
  const open = useTerminalTabsStore((s) => s.open);
  const pinned = (id: string, p: number) => pins.some((x) => x.paneId === id && x.pid === p);

  // The pane on screen is a tab from the moment its pid is known; once the
  // list was read, so a pin is not taken for an open pane, and with the name
  // the list gives it then. Once for each pane shown: a list read after
  // another window closed its tab does not open it again. A pinned pane
  // stays on the open list, unshown: unpinned anywhere, it is an open tab
  // again.
  const pinKey = pins.map((p) => `${p.paneId}:${p.pid}`).join(",");
  const addedFor = useRef<string | null>(null);
  useEffect(() => {
    // Another pane, or none: the next time this one shows, it opens again.
    if (paneId === null || pid === null) { addedFor.current = null; return; }
    const key = `${paneId}:${pid}`;
    if (addedFor.current !== key) addedFor.current = null;
    if (!sessions || pinKey.split(",").includes(key) || addedFor.current === key) return;
    addedFor.current = key;
    const hit = findPane(sessions, paneId, pid);
    useTerminalTabsStore.getState().add(paneId, pid, hit ? terminalDisplayName(hit.pane) : undefined);
  }, [sessions, pinKey, paneId, pid]);
  // An open pane keeps the name the list last gave it.
  useEffect(() => {
    if (!sessions) return;
    const tabs = useTerminalTabsStore.getState();
    tabs.rename(tabs.open.flatMap((t) => {
      const hit = findPane(sessions, t.paneId, t.pid);
      return hit ? [{ paneId: t.paneId, pid: t.pid, name: terminalDisplayName(hit.pane) }] : [];
    }));
  }, [sessions]);

  const shownPin = paneId !== null ? pins.find((p) => p.paneId === paneId && (pid === null || p.pid === pid)) : undefined;
  // An address without a pid shows the tab of that id while its pane is
  // looked up; the lookup's pid then names it (a new pane with the id is a
  // tab of its own).
  const shownOpen = paneId !== null && pid === null && !shownPin ? open.find((t) => t.paneId === paneId && !pinned(t.paneId, t.pid)) : undefined;
  const shown = paneId === null ? "first" : tabId(paneId, shownPin?.pid ?? shownOpen?.pid ?? pid);
  const tabs: PanelTabItem[] = pins.map((p) => ({
    id: tabId(p.paneId, p.pid), ...tabText(sessions, p.paneId, p.pid), icon, dataTerminalTab: p.paneId, order: "pins"
  }));
  const closable = open.filter((t) => !pinned(t.paneId, t.pid)).map((t) => ({ paneId: t.paneId, pid: t.pid as number | null, name: t.name }));
  const kept = new Set(closable.map((t) => tabId(t.paneId, t.pid)));
  // The address names a pane not a tab yet (its pid or the list still to
  // come): it shows as one meanwhile.
  if (paneId !== null && !shownPin && !closable.some((t) => tabId(t.paneId, t.pid) === shown)) closable.push({ paneId, pid, name: undefined });

  const select = (id: string) => {
    if (id === "first") { navigate("/terminals"); return; }
    const { paneId: target, pid: targetPid } = tabPane(id);
    navigate(targetPid !== null ? terminalHref(target, targetPid) : `/terminals/pane/${encodeURIComponent(target)}`);
  };
  const ids = [...tabs.map((t) => t.id), ...closable.map((t) => tabId(t.paneId, t.pid))];
  // Closed while shown: the tab to its right shows, else the one to its left.
  const closeTab = (t: { paneId: string; pid: number | null }) => {
    const id = tabId(t.paneId, t.pid);
    if (t.pid !== null) useTerminalTabsStore.getState().close(t.paneId, t.pid);
    if (id !== shown) return;
    const at = ids.indexOf(id);
    const next = ids[at + 1] ?? ids[at - 1];
    select(next ?? "first");
  };
  for (const t of closable) {
    tabs.push({
      id: tabId(t.paneId, t.pid), ...tabText(sessions, t.paneId, t.pid, t.name), icon, dataTerminalTab: t.paneId,
      onClose: () => closeTab(t),
      // Only one of this browser's open tabs has a place to keep: not one
      // still looked up, nor one shown here that another window closed.
      order: kept.has(tabId(t.paneId, t.pid)) ? "open" : undefined
    });
  }
  // A tab dropped on (or moved past) another of its kind takes its place.
  const pinIds = pins.map((p) => tabId(p.paneId, p.pid));
  const openIds = closable.map((t) => tabId(t.paneId, t.pid)).filter((id) => kept.has(id));
  const reorder = (id: string, overId: string) => {
    const from = pinIds.indexOf(id);
    const to = pinIds.indexOf(overId);
    if (from >= 0 && to >= 0) {
      void useTerminalsStore.getState().reorderPins(arrayMove(pins, from, to).map(({ paneId: p, pid: n }) => ({ paneId: p, pid: n })));
      return;
    }
    if (!openIds.includes(id) || !openIds.includes(overId)) return;
    const a = tabPane(id);
    const b = tabPane(overId);
    if (a.pid !== null && b.pid !== null) useTerminalTabsStore.getState().move(a.paneId, a.pid, b.paneId, b.pid);
  };
  const moveFor = (key: string): TerminalTabMove | undefined => {
    const group = pinIds.includes(key) ? pinIds : openIds.includes(key) ? openIds : null;
    if (!group) return undefined;
    const at = group.indexOf(key);
    return {
      left: at > 0 ? () => reorder(key, group[at - 1]!) : undefined,
      right: at < group.length - 1 ? () => reorder(key, group[at + 1]!) : undefined
    };
  };

  const withPid = useCallback((found: number) => {
    if (paneId !== null) navigate(terminalHref(paneId, found), { replace: true });
  }, [navigate, paneId]);
  // The terminal on screen: the address's pane by the address's pid. A
  // pid-less one is looked up, then given its pid, even when a pin has the
  // id (the pin's pane may be gone and the id another pane's).
  const terminalKey = paneId === null ? null : tabId(paneId, pid);
  const keptKeys = useKeptTerminals("terminals-page", terminalKey, keptTerminalLimit(phone), ids);
  const newTerminal = async () => {
    const shell = await useTerminalsStore.getState().openShell();
    if (shell) navigate(terminalHref(shell.paneId, shell.pid));
  };

  // The row is the pane's header (the phone's top bar, beside ☰): its tabs
  // name the terminals, so the one shown draws no header of its own. New
  // terminal follows the tabs, as a browser's does (beside "N ⌄" once they
  // scroll), away from ⋯; the shown terminal's controls are the header's
  // actions, at its far end, not the row's tools: a header saying
  // Reconnecting… takes its room from the title, which would slide them
  // under the word.
  return (
    <TerminalControlsSlotProvider>
      <PaneHeaderTitle>
        <PanelTabRow
          fill
          first={{ label: "All", icon: <LayoutGrid aria-hidden className="size-3.5 shrink-0" /> }}
          tabs={tabs}
          active={shown}
          onSelect={select}
          onReorder={reorder}
          tools={null}
          after={(
            <Button variant="ghost" size="icon-sm" aria-label="New terminal" title="New terminal" onClick={() => void newTerminal()} className="shrink-0 text-chrome hover:text-foreground">
              <Plus className="size-4" />
            </Button>
          )}
          ariaLabel="Terminals"
        />
      </PaneHeaderTitle>
      <PaneHeaderActions>
        <TerminalControlsSlot />
      </PaneHeaderActions>
      {/* The terminals shown last stay connected behind the one shown, hidden
          by visibility, which keeps their size: at no size, one fitted to the
          browser would shrink its pane. */}
      <div className="relative flex h-full min-h-0 flex-col">
        {pageShown && paneId === null && <AllTerminals />}
        {keptKeys.map((key) => {
          const at = key.lastIndexOf(":");
          const isShown = key === terminalKey;
          return (
            <div key={key} data-kept-terminal={key} inert={!isShown} className={cn("absolute inset-0 flex flex-col", !isShown && "invisible")}>
              <TerminalTab paneId={key.slice(0, at)} pid={Number(key.slice(at + 1)) || null} shown={isShown} onPid={isShown ? withPid : undefined} move={moveFor(key)} />
            </div>
          );
        })}
      </div>
    </TerminalControlsSlotProvider>
  );
}
