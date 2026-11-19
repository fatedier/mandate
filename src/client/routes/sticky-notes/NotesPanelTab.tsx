import { useContext } from "react";
import { PageShownContext } from "@/lib/page-shown";
import { usePageVisible } from "@/hooks/usePageVisible";
import { useAgentPageUi } from "@/store/agent-page-ui";
import { NotesWall } from "./NotesWall";

/** The Notes tab's view, drawn while its tab is chosen: the wall, in sight
 *  while the panel is turned to (a narrow row on its side) on a page in front. */
export function NotesPanelTab() {
  const turnedTo = useAgentPageUi((s) => s.open && (!s.narrow || s.narrowView === "side"));
  const kept = useContext(PageShownContext);
  const visible = usePageVisible();
  return (
    <div data-slot="notes-panel" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pt-4 pb-8">
      <NotesWall inSight={turnedTo && kept && visible} />
    </div>
  );
}
