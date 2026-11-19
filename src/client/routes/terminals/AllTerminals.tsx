import { useState } from "react";
import { Link } from "react-router";
import { ChevronDown, Pin, Search, SquareTerminal } from "lucide-react";
import { ListRowSkeleton } from "@/components/ui/skeleton";
import { StateAction, StateMessage } from "@/components/ViewState";
import { cn } from "@/lib/utils";
import { compactPath } from "@/lib/format";
import { searchTerminals, sessionLabel, terminalDisplayName, terminalHref, windowHref } from "@/lib/terminals-model";
import { useTerminalsStore } from "@/store/terminals";
import type { SessionDto, SessionPaneDto } from "@shared/api-contracts";
import { PinButton } from "./PinButton";

const FOLDED_KEY = "mandate.terminals.folded";

function readFolded(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : []);
  } catch {
    return new Set();
  }
}

function writeFolded(folded: Set<string>): void {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])); } catch { /* kept for this visit only */ }
}

/** The All tab: every tmux session, its windows and their panes, and a search over them. */
export function AllTerminals() {
  const sessions = useTerminalsStore((s) => s.sessions);
  const status = useTerminalsStore((s) => s.status);
  const error = useTerminalsStore((s) => s.error);
  const noPins = useTerminalsStore((s) => s.pins.length === 0);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState(readFolded);
  const toggle = (name: string) => setFolded((current) => {
    const next = new Set(current);
    if (next.has(name)) next.delete(name); else next.add(name);
    writeFolded(next);
    return next;
  });

  let body;
  if (sessions === null) {
    body = status === "error"
      ? <StateMessage title="Couldn't load tmux sessions" detail={error} action={<StateAction onClick={() => void useTerminalsStore.getState().refresh()}>Retry</StateAction>} />
      : <ListRowSkeleton rows={3} />;
  } else if (sessions.length === 0) {
    body = (
      <div className="py-16 text-center">
        <SquareTerminal className="mx-auto h-8 w-8 text-chrome/50" aria-hidden />
        <h3 className="mt-3 text-lg font-semibold">No tmux sessions detected</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">Open one with New terminal, or start tmux in your own terminal.</p>
      </div>
    );
  } else if (query.trim()) {
    const hits = searchTerminals(sessions, query);
    body = hits.length === 0
      ? <p className="px-2 py-6 text-sm text-muted-foreground">No terminals match.</p>
      : <div className="flex flex-col">{hits.map((hit) => <PaneRow key={hit.pane.paneId} pane={hit.pane} where={`${hit.session} › ${hit.window.name}`} />)}</div>;
  } else {
    body = (
      <div className="flex flex-col gap-3">
        {sessions.map((session) => <SessionRows key={session.name} session={session} folded={folded.has(session.name)} onToggle={() => toggle(session.name)} />)}
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-3 px-4 pt-3 pb-6 md:px-8">
        <label className="flex h-8 items-center gap-1.5 rounded-md border border-border-soft bg-background px-2 text-sm focus-within:border-ring max-md:h-10">
          <Search aria-hidden className="size-3.5 shrink-0 text-faint" />
          <input
            type="search"
            aria-label="Search terminals"
            placeholder="Search terminals"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint"
          />
        </label>
        {noPins && sessions && sessions.length > 0 && !query.trim() && (
          <p data-slot="terminals-pin-hint" className="flex items-start gap-1.5 px-1 text-sm text-muted-foreground">
            <Pin aria-hidden className="mt-0.5 size-3.5 shrink-0 text-faint" />
            Pin the terminals you use often to keep them one click away.
          </p>
        )}
        {body}
      </div>
    </div>
  );
}

function SessionRows({ session, folded, onToggle }: { session: SessionDto; folded: boolean; onToggle: () => void }) {
  return (
    <section className="flex flex-col">
      <button
        type="button"
        aria-expanded={!folded}
        onClick={onToggle}
        className="hit relative flex h-8 items-center gap-1.5 rounded-md px-2 text-left text-sm font-semibold hover:bg-sel pointer-coarse:h-11"
      >
        <ChevronDown aria-hidden className={cn("size-3.5 shrink-0 text-faint transition-transform", folded && "-rotate-90")} />
        <span className="min-w-0 truncate font-mono">{session.name}</span>
        <span className="shrink-0 text-2xs font-normal text-faint">{sessionLabel(session)}</span>
      </button>
      {!folded && session.windows.map((window) => (
        <div key={window.windowId || window.name} className="flex flex-col">
          {window.windowId
            ? <Link to={windowHref(window.windowId)} className="w-fit truncate pt-1.5 pb-0.5 pl-7 font-mono text-2xs text-faint hover:text-foreground pointer-coarse:min-w-11 pointer-coarse:py-3.5">{window.name}</Link>
            : <span className="truncate pt-1.5 pb-0.5 pl-7 font-mono text-2xs text-faint">{window.name}</span>}
          {window.panes.map((pane) => <PaneRow key={pane.paneId} pane={pane} indent />)}
        </div>
      ))}
    </section>
  );
}

function PaneRow({ pane, where, indent = false }: { pane: SessionPaneDto; where?: string; indent?: boolean }) {
  const name = terminalDisplayName(pane);
  // The link opens the pane (a new browser tab too); the pin sits beside it,
  // not in it, so pinning never opens the pane.
  return (
    <div data-pane-row={pane.paneId} className="group relative flex h-8 items-center gap-2 rounded-md pr-1 hover:bg-sel pointer-coarse:h-11">
      <Link
        to={terminalHref(pane.paneId, pane.pid)}
        data-open-pane={pane.paneId}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-md text-sm text-muted-foreground group-hover:text-foreground",
          indent ? "pl-7" : "pl-2"
        )}
      >
        <SquareTerminal aria-hidden className="size-3.5 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <span className="max-w-[46%] shrink-0 truncate font-mono text-2xs text-faint">{where ?? [pane.currentCommand, compactPath(pane.currentPath)].filter(Boolean).join(" · ")}</span>
      </Link>
      <PinButton paneId={pane.paneId} pid={pane.pid} />
    </div>
  );
}
