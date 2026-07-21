import { Skeleton } from "@/components/ui/skeleton";

/** Placeholder for the log, shaped like the log: a filter row and a run of
 *  one-line rows. It used to draw four stat cards above the list, which is now
 *  a different tab — a skeleton that promises a layout the page will not
 *  produce is worse than no skeleton at all. */
export function ActivitySkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border-soft bg-card">
      <div className="flex items-center gap-2 border-b border-border-soft px-3 py-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
      <div className="grid gap-2 border-b border-border-soft px-3 py-2 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_unused, index) => (
          <Skeleton key={index} className="h-8" />
        ))}
      </div>
      <ul>
        {Array.from({ length: 8 }).map((_unused, index) => (
          <li
            key={index}
            className="flex items-center gap-2 border-b border-border-soft px-3 py-2 last:border-b-0"
          >
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 flex-1 max-w-[10rem]" />
            <Skeleton className="ml-auto h-3 w-10" />
            <Skeleton className="h-3 w-10" />
          </li>
        ))}
      </ul>
    </div>
  );
}
