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

const NEEDS_USER_DOT: Record<string, string> = {
  input: "bg-status-input",
  review: "bg-status-review",
  idle: "bg-faint"
};

const NEEDS_USER_LABEL: Record<string, string> = {
  input: "input",
  review: "review",
  idle: "idle"
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
      className={cn(
        "group block w-full text-left my-1 px-3 py-2.5 rounded-lg border transition-colors",
        "border-border-soft bg-muted/30 hover:bg-muted/50 hover:border-border"
      )}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="label-micro text-chrome">
          Work item
        </span>
        <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </span>
      </div>

      <div className="flex items-start gap-2">
        <span
          aria-label={`needs-user: ${needsUserKey}`}
          className={cn("mt-1.5 shrink-0 h-2 w-2 rounded-full", NEEDS_USER_DOT[needsUserKey])}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-snug text-foreground">
            {title}
          </div>
          {body ? (
            <div className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
              {body}
            </div>
          ) : null}
          {(featureRefs.length > 0 || projectRefs.length > 0) ? (
            <div className="mt-1.5">
              <WorkItemRefsInline
                featureRefs={featureRefs}
                projectRefs={projectRefs}
                max={3}
              />
            </div>
          ) : null}
          {!liveItem ? (
            <div className="mt-1 text-2xs text-muted-foreground/60">
              {NEEDS_USER_LABEL[needsUserKey]} · loading live state…
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
