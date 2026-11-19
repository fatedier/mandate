import { useContext } from "react";
import { PaneHeaderTitle } from "@/shell/pane-header-slots";
import { PageShownContext } from "@/lib/page-shown";
import { usePageVisible } from "@/hooks/usePageVisible";
import { NotesWall } from "./NotesWall";

/** The Notes page: the agent's sticky notes, the wall the panel tab draws too. */
export function NotesPage() {
  const kept = useContext(PageShownContext);
  const visible = usePageVisible();
  return (
    <div data-slot="notes-page" className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
      <PaneHeaderTitle>
        <h1 className="truncate text-sm font-semibold text-foreground">Notes</h1>
      </PaneHeaderTitle>
      <div className="px-4 pt-2 pb-8 md:px-7">
        <NotesWall inSight={kept && visible} />
      </div>
    </div>
  );
}
