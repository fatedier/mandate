import type { ReactNode, RefObject } from "react";

/** The area after the sidebar. The thread page places its own worker panel;
 *  nothing else shares this row any more. */
export function Workspace({ children }: { children: ReactNode; scrollRef?: RefObject<HTMLElement | null> }) {
  return (
    <div className="group/workspace relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
