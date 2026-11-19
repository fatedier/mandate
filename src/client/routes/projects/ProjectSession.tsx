import { useState } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";
import type { Project } from "@/store/projects";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api-paths";
import { cn } from "@/lib/utils";

/** A project whose tmux session is gone says so: the icon always, the words
 *  from md up (the title keeps the warning on a phone). Nothing while it is there. */
export function SessionMissing({ project }: { project: Project }) {
  if (project.tmuxStatus !== "gone") return null;
  return (
    <span
      className="flex shrink-0 items-center gap-1 text-2xs text-amber"
      title={project.ownership === "adopted"
        ? "Original tmux session is gone — adopt link broken"
        : "tmux session was killed externally — click Restore to rebuild"}
    >
      <AlertTriangle className="size-3.5" />
      {/* The words yield below md so a phone's line keeps room for Restore and ⋯. */}
      <span className="hidden md:inline">session missing</span>
    </span>
  );
}

/** Rebuilds a lost tmux session of a project Mandate made; nothing otherwise. */
export function RestoreButton({ project, className }: { project: Project; className?: string }) {
  const request = useApi();
  const [restoring, setRestoring] = useState(false);
  if (project.tmuxStatus !== "gone" || project.ownership !== "app") return null;
  const restore = async () => {
    setRestoring(true);
    try {
      await request("POST", api.projectReconcile(project.id), {});
    } finally {
      setRestoring(false);
    }
  };
  return (
    <Button variant="ghost" size="xs" onClick={restore} disabled={restoring} className={cn("text-chrome hover:text-foreground", className)}>
      <RotateCw className={cn("size-3.5", restoring && "animate-spin")} />
      {restoring ? "Restoring…" : "Restore"}
    </Button>
  );
}
