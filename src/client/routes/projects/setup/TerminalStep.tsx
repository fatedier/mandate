
import { TMUX_INSTALL_HINT, withTmuxInstallHint } from "@/lib/tmux-install";
import { StatusLine } from "./shared";
import type { SetupStatusResponse } from "@shared/api-contracts";
import { RefreshButton } from "@/components/RefreshButton";

export function TerminalStep({
  status,
  loading,
  onRefresh
}: {
  status: SetupStatusResponse;
  loading: boolean;
  onRefresh: () => void;
}) {
  const terminalDetail = status.terminal.ready
    ? "Mandate can create and inspect visible terminal workspaces."
    : status.terminal.error
      ? withTmuxInstallHint(status.terminal.error)
      : TMUX_INSTALL_HINT;
  return (
    <div className="rounded-lg border border-border-soft bg-background/45 p-4">
      <StatusLine
        ready={status.terminal.ready}
        label={status.terminal.ready ? "tmux is ready" : "tmux is unavailable"}
        detail={terminalDetail}
        multiline={!status.terminal.ready}
      />
      <RefreshButton
        what="terminal status"
        refreshing={loading}
        onRefresh={onRefresh}
        className="mt-4"
      />
    </div>
  );
}
