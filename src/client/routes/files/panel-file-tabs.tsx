import { useState } from "react";
import { FileText, Image as ImageGlyph } from "lucide-react";
import type { PanelTabItem } from "@/components/PanelTabRow";
import { fileNameOf, isImagePath } from "@/lib/file-link";
import { filePathOfTab } from "@/lib/panel-tabs";

/** A right panel's file tabs (a thread's, the personal agent's): each named by its
 *  file's name from the start, under "Files"; and the files drawn, each from
 *  the first time its tab shows and kept while it is open, as canvas tabs
 *  are. */
export function usePanelFileTabs(tabIds: readonly string[], active: string, close: (tabId: string) => void): {
  items: ReadonlyMap<string, PanelTabItem>;
  kept: string[];
  activeFile: string | null;
} {
  const activeFile = filePathOfTab(active);
  const [drawn, setDrawn] = useState<ReadonlySet<string>>(() => new Set());
  if (activeFile && !drawn.has(activeFile)) setDrawn(new Set(drawn).add(activeFile));
  const items = new Map<string, PanelTabItem>();
  const paths: string[] = [];
  for (const id of tabIds) {
    const path = filePathOfTab(id);
    if (!path) continue;
    paths.push(path);
    const Icon = isImagePath(path) ? ImageGlyph : FileText;
    items.set(id, {
      id,
      label: fileNameOf(path),
      icon: <Icon aria-hidden className="size-3.5 shrink-0" />,
      group: "Files",
      onClose: () => close(id),
      dataFileTab: path
    });
  }
  return { items, kept: paths.filter((path) => drawn.has(path) || path === activeFile), activeFile };
}
