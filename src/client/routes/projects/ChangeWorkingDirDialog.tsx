import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api-paths";
import { errorText } from "@shared/error-text";
import type { ChangeProjectWorkingDirResponse } from "@shared/api-contracts";
import { TextInput } from "./setup/shared";

/** A directory without its trailing slashes: the same on both sides of a comparison. */
const normalized = (dir: string) => dir.replace(/\/+$/, "");

/** "a" works / "a" and "b" work: the workers whose panes stay behind. */
function stayBehind(names: readonly string[]): string {
  const sorted = [...names].sort();
  const one = sorted.length === 1;
  const named = one ? `"${sorted[0]}"` : `${sorted.slice(0, -1).map((n) => `"${n}"`).join(", ")} and "${sorted.at(-1)}"`;
  return `${named} ${one ? "works" : "work"} in the project directory: panes already open in ${one ? "its window" : "their windows"} ` +
    "keep running in the old directory until they are restarted.";
}

/** A project's working directory, changed in place: the project keeps its
 *  threads, workers and memories. The server refuses a directory a worker's
 *  worktree does not belong to, in words this shows as they are. */
export function ChangeWorkingDirDialog({ projectId, projectName, workingDir, inProjectWorkers, onDone }: {
  projectId: string;
  projectName: string;
  workingDir: string;
  /** Workers that work in the project's directory, not a worktree of their own. */
  inProjectWorkers: readonly string[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(workingDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = draft.trim();
  const unchanged = !next || normalized(next) === normalized(workingDir);

  const save = async () => {
    if (busy || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(api.projectById(projectId), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workingDir: next })
      });
      const body = await r.json().catch(() => null) as ChangeProjectWorkingDirResponse | null;
      if (!r.ok || !body || "error" in body) {
        setError(body && "error" in body ? body.error : `The change failed (HTTP ${r.status}).`);
        return;
      }
      onDone();
    } catch (e: unknown) {
      setError(errorText(e, "The change failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onDone(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change working directory</DialogTitle>
          <DialogDescription>"{projectName}" keeps its threads, workers and memories.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <TextInput label="Working directory" value={draft} onChange={setDraft} placeholder="/path/to/project" mono autoFocus />
          {inProjectWorkers.length > 0 && <p className="text-xs leading-5 text-muted-foreground">{stayBehind(inProjectWorkers)}</p>}
          {error && <p className="whitespace-pre-line text-xs leading-5 text-red">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onDone} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy || unchanged}>{busy ? "Saving…" : "Save"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
