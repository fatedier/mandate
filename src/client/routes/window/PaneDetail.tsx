import { useState } from "react";
import { useNavigate } from "react-router";
import { Terminal as TerminalIcon, X as CloseIcon } from "lucide-react";
import { toast } from "sonner";
import type { SnapshotPane } from "@/lib/snapshot-types";
import { StatusDot } from "@/components/StatusDot";
import { compactPath } from "@/lib/format";
import { RelativeTime } from "@/components/RelativeTime";
import { confirmAction } from "@/components/confirm-action";
import { api } from "@/lib/api-paths";
import { paneStatus, paneTitle } from "@/routes/window/pane-helpers";
import { PaneCardShell } from "@/routes/window/PaneCardShell";

interface PaneDetailProps {
  pane: SnapshotPane;
  projectSlug: string;
  featureSlug: string;
}

export function PaneDetail({ pane, projectSlug, featureSlug }: PaneDetailProps) {
  const navigate = useNavigate();
  const [killing, setKilling] = useState(false);

  const handleTerminal = () => {
    if (!pane.paneId) return;
    navigate(
      `/projects/${encodeURIComponent(projectSlug)}/features/${encodeURIComponent(featureSlug)}/pane/${encodeURIComponent(pane.paneId)}`
    );
  };

  const handleKill = async () => {
    if (killing || !pane.paneId) return;
    if (!(await confirmAction({
      title: `Close pane "${paneTitle(pane)}"?`,
      description: "Anything running in it will be killed.",
      confirmLabel: "Close",
      destructive: true
    }))) return;
    setKilling(true);
    try {
      const r = await fetch(api.paneById(pane.paneId), { method: "DELETE" });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body?.error ?? `Kill failed (HTTP ${r.status})`);
        return;
      }
      toast.success("Killed pane");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Kill request failed");
    } finally {
      setKilling(false);
    }
  };

  return (
    <PaneCardShell
      title={paneTitle(pane)}
      titleMono={!pane.metadata?.name?.trim()}
      statusIndicator={<StatusDot status={paneStatus(pane)} className="shrink-0" />}
      metadata={
        <>
          {pane.metadata?.description && <span className="truncate">{pane.metadata.description}</span>}
          <span className="truncate">{compactPath(pane.currentPath)}</span>
          {pane.changedAt && <span className="shrink-0"><RelativeTime value={pane.changedAt} /></span>}
        </>
      }
      preview={pane.preview}
      onActivate={handleTerminal}
      activateDisabled={!pane.paneId}
      menuItems={[
        {
          label: "Terminal",
          icon: <TerminalIcon className="h-4 w-4" />,
          onSelect: handleTerminal,
          disabled: !pane.paneId
        },
        {
          label: killing ? "Closing…" : "Close pane",
          icon: <CloseIcon className="h-4 w-4" />,
          onSelect: handleKill,
          disabled: !pane.paneId || killing,
          destructive: true
        }
      ]}
    />
  );
}
