import { Fragment, type Ref } from "react";
import { cn } from "@/lib/utils";
import { SharedWords } from "./ShareRow";
import type { ShareItem } from "./share-selection";

/** An image cannot be scrolled: a table wider than the card, which the chat
 *  scrolls sideways, wraps to fit it instead. Every cell may wrap (the chat
 *  keeps short ones on one line and long ones at least 28ch wide), between
 *  words or, past that, anywhere. */
const TABLES_FIT = "[&_[data-slot=table-scroll]]:overflow-visible [&_table]:[overflow-wrap:anywhere] [&_table_code]:[overflow-wrap:anywhere] [&_td]:whitespace-normal [&_th]:whitespace-normal [&_td>span]:min-w-0 [&_th>span]:min-w-0";

/** What the shared image draws: the picked rows in order, on the app's
 *  background in its current theme, 480px wide; a thin rule where rows were
 *  left out between two picked ones. Nothing else: no title, names or times. */
export function ShareCard({ items, ref }: { items: readonly ShareItem[]; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} data-slot="share-card" className={cn("flex w-[480px] flex-col gap-4 bg-background p-7 text-foreground", TABLES_FIT)}>
      {items.map((item) => (
        <Fragment key={item.key}>
          {item.skipBefore && <div aria-hidden data-slot="share-skip" className="mx-6 h-px shrink-0 bg-border-soft" />}
          <SharedWords side={item.side} text={item.text} />
        </Fragment>
      ))}
    </div>
  );
}
