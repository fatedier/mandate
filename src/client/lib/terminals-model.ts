import type { SessionDto, SessionPaneDto, SessionWindowDto } from "@shared/api-contracts";
import { compactPath } from "@/lib/format";

/** A shell titles its pane `user@host:path`: the folder says the same, shorter. */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set(["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "nu"]);

type NamedPane = Pick<SessionPaneDto, "metadata" | "currentCommand" | "currentPath" | "title">;

const folderOf = (pane: Pick<SessionPaneDto, "currentPath">) => compactPath(pane.currentPath) || pane.currentPath;
const commandAndFolder = (pane: NamedPane) => [pane.currentCommand, folderOf(pane)].filter(Boolean).join(" · ");

/** What a pane is called on the Terminals page: Mandate's name for it, a
 *  shell by its folder, a program by the title it set, else its command and
 *  folder. */
export function terminalDisplayName(pane: NamedPane): string {
  const named = pane.metadata?.name.trim();
  if (named) return named;
  if (SHELL_COMMANDS.has(pane.currentCommand)) return commandAndFolder(pane);
  return pane.title?.trim() || commandAndFolder(pane);
}

/** `command · session › window · folder` */
export function terminalWhere(pane: Pick<SessionPaneDto, "currentCommand" | "currentPath">, session: string, window: string): string {
  return [pane.currentCommand, `${session} › ${window}`, folderOf(pane)].filter(Boolean).join(" · ");
}

export interface TerminalHit {
  pane: SessionPaneDto;
  session: string;
  window: SessionWindowDto;
}

function everyPane(sessions: SessionDto[]): TerminalHit[] {
  return sessions.flatMap((s) => s.windows.flatMap((window) => window.panes.map((pane) => ({ pane, session: s.name, window }))));
}

/** Panes whose title, name, command, folder, session or window holds `q`. */
export function searchTerminals(sessions: SessionDto[], q: string): TerminalHit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return everyPane(sessions).filter(({ pane, session, window }) =>
    [pane.title ?? "", terminalDisplayName(pane), pane.currentCommand, pane.currentPath, folderOf(pane), session, window.name]
      .some((text) => text.toLowerCase().includes(needle)));
}

/** A tab's tooltip: the pane's full name, then where it is. */
export function terminalTooltip(hit: TerminalHit): string {
  return `${terminalDisplayName(hit.pane)}\n${hit.session} › ${hit.window.name}`;
}

/** The pane by id alone, for an address that names no pid yet. */
export function findPaneById(sessions: SessionDto[], paneId: string): TerminalHit | null {
  return everyPane(sessions).find((hit) => hit.pane.paneId === paneId) ?? null;
}

export function findPane(sessions: SessionDto[], paneId: string, pid: number): TerminalHit | null {
  return everyPane(sessions).find((hit) => hit.pane.paneId === paneId && hit.pane.pid === pid) ?? null;
}

export function terminalHref(paneId: string, pid: number): string {
  return `/terminals/pane/${encodeURIComponent(paneId)}?pid=${pid}`;
}

export function windowHref(windowId: string): string {
  return `/terminals/window/${encodeURIComponent(windowId)}`;
}

/** A session row's small text. */
export function sessionLabel(session: SessionDto): string {
  if (session.projectName) return `${session.projectName} · project`;
  const n = session.windows.length;
  return `${n} window${n === 1 ? "" : "s"}`;
}
