import { lazy, Suspense } from "react";
import { LoadingLine } from "@/components/ViewState";
import { fileTabId } from "@/lib/panel-tabs";
import type { FileTarget } from "@/lib/file-link";
import { cn } from "@/lib/utils";

// The viewer loads with the first file opened.
const FileView = lazy(() => import("./FileView").then((m) => ({ default: m.FileView })));

/** A panel's drawn file tabs: the one shown, the others kept hidden. */
export function PanelFileViews({ kept, active, lines }: {
  kept: readonly string[];
  active: string | null;
  lines: Readonly<Record<string, { line?: number; end?: number; opened?: number }>>;
}) {
  return kept.map((path) => (
    <div key={path} data-slot="file-tab-view" className={cn("min-h-0 flex-1 flex-col", path === active ? "flex" : "hidden")}>
      <Suspense fallback={<div className="p-4"><LoadingLine /></div>}>
        <FileView target={targetOf(path, lines[fileTabId(path)])} opened={lines[fileTabId(path)]?.opened} presentation="panel" shown={path === active} />
      </Suspense>
    </div>
  ));
}

function targetOf(path: string, lines: { line?: number; end?: number } | undefined): FileTarget {
  return { path, ...(lines?.line !== undefined ? { line: lines.line } : {}), ...(lines?.end !== undefined ? { end: lines.end } : {}) };
}
