import { useEffect } from "react";
import { ArrowUpRight } from "lucide-react";
import { useWorkItemsStore } from "@/store/work-items";
import { cn } from "@/lib/utils";
import { WorkItemRefsInline } from "./work-items/WorkItemRefs";

interface WorkItemMessageBlockProps {
  itemId: string;
  /** Server-rendered fallback title — used until the store fetches the live item. */
  fallbackTitle: string;
  /** Server-rendered fallback body — used until the store fetches the live item. */
  fallbackBody?: string;
  onOpen: (id: string) => void;
}

const NEEDS_USER_LABEL: Record<string, string> = {
  input: "Needs input",
  review: "Review"
};

/**
 * Inline card rendered in chat when the user promoted a work_item into the
 * conversation. Pulls live state from the store so needsUser stays
 * accurate even if the item changes after promote.
 */
export function WorkItemMessageBlock({
  itemId,
  fallbackTitle,
  fallbackBody,
  onOpen
}: WorkItemMessageBlockProps) {
  const liveItem = useWorkItemsStore((s) => s.items.get(itemId));
  const fetchDetail = useWorkItemsStore((s) => s.fetchDetail);

  useEffect(() => {
    if (!liveItem) void fetchDetail(itemId);
  }, [itemId, liveItem, fetchDetail]);

  const title = liveItem?.title ?? fallbackTitle;
  const body = liveItem?.summary ?? fallbackBody ?? null;
  const needsUser = liveItem?.needsUser ?? null;
  const needsUserKey = needsUser ?? "idle";
  const featureRefs = liveItem ? [liveItem.featureId] : [];
  const projectRefs = liveItem ? [liveItem.projectId] : [];

  return (
    <button
      type="button"
      onClick={() => onOpen(itemId)}
      className="group my-1 block w-full overflow-hidden rounded-lg border border-border-soft bg-panel text-left transition-colors hover:border-border"
    >
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
        <span
          aria-label={`needs-user: ${needsUserKey}`}
          className={cn("pill", needsUserKey === "input" ? "pill-red" : needsUserKey === "review" ? "pill-review" : "pill-neutral")}
        >
          {needsUserKey === "idle" ? "Work item" : NEEDS_USER_LABEL[needsUserKey]}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{title}</span>
        <ArrowUpRight className="size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </div>
      {/* Padding on the outer element, clamp on the inner one: a clamp on a
          padded element leaks a partial third line into the padding box. */}
      {body ? (
        <div className="px-3 py-2">
          <div className="line-clamp-2 text-xs leading-[1.55] text-muted-foreground">{body}</div>
        </div>
      ) : null}
      {(featureRefs.length > 0 || projectRefs.length > 0) ? (
        <div className="px-3 pb-2">
          <WorkItemRefsInline featureRefs={featureRefs} projectRefs={projectRefs} max={3} />
        </div>
      ) : null}
      {!liveItem ? (
        <div className="px-3 pb-2 text-2xs text-faint">loading live state…</div>
      ) : null}
    </button>
  );
}
