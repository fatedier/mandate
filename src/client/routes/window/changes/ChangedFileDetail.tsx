import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { FeatureChangedFileDto } from "@shared/api-contracts";
import type { ChangesDiffCache } from "./changes-diff-cache";
import { DiffHunkView } from "./DiffHunkView";

const STATUS_LABEL: Record<FeatureChangedFileDto["status"], string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed"
};

export function ChangedFileDetail({
  file,
  cache,
  unified = false
}: {
  file: FeatureChangedFileDto;
  cache: ChangesDiffCache;
  unified?: boolean;
}) {
  const [diff, setDiff] = useState(() => cache.get(file.path) ?? null);
  const hunks = diff?.hunks ?? null;
  const truncated = diff?.truncated ?? false;
  const [error, setError] = useState("");

  useEffect(() => {
    if (file.binary) return;
    let alive = true;
    // Requests belong to the page revision, so returning to an in-flight file
    // reuses its request. Leaving the page or refreshing cancels the revision.
    void cache.load(file.path).then(
      (result) => { if (alive) setDiff(result); },
      (error: unknown) => {
        if (alive && !cache.aborted) setError(error instanceof Error ? error.message : "patch fetch failed");
      }
    );
    return () => {
      alive = false;
    };
  }, [cache, file.path, file.binary]);

  return (
    <section className="border border-border-soft rounded-md overflow-hidden">
      <header className="flex flex-wrap items-center gap-2 border-b border-border-soft px-3 py-2 text-sm">
        <span className="font-mono break-all">{file.path}</span>
        {file.oldPath ? (
          <span className="inline-flex min-w-0 items-center gap-1 break-all text-faint">
            <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {file.oldPath}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2 shrink-0">
          {file.uncommitted ? (
            <span className="rounded-xs px-1.5 py-0.5 label-micro bg-amber/15 text-amber">
              uncommitted
            </span>
          ) : null}
          <span className="text-faint text-xs">{STATUS_LABEL[file.status]}</span>
          {file.binary ? (
            <span className="text-faint text-xs">binary</span>
          ) : (
            <span className="text-xs">
              <span className="text-diff-add-fg">+{file.additions ?? 0}</span>{" "}
              <span className="text-diff-del-fg">−{file.deletions ?? 0}</span>
            </span>
          )}
        </span>
      </header>
      {file.binary ? (
        <p className="p-3 text-sm text-faint">Binary file — no diff to show.</p>
      ) : (
        <>
          {error ? <p className="p-3 text-sm text-destructive">{error}</p> : null}
          {hunks === null && !error ? <p className="p-3 text-sm text-faint">Loading…</p> : null}
          {hunks !== null && hunks.length === 0 ? (
            <p className="p-3 text-sm text-faint">No textual changes.</p>
          ) : null}
          {hunks !== null && hunks.length > 0 ? (
            <DiffHunkView hunks={hunks} unified={unified} />
          ) : null}
          {truncated ? (
            <p className="p-2 text-xs text-faint border-t border-border-soft">
              Patch truncated — view the rest in the terminal.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
