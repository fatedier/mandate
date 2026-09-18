import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-muted/60", className)}
      {...props}
    />
  );
}

/** Vertical stack of card-shaped skeleton rows, mirroring the dashboard /
 *  sessions / windows list layouts (a label row + a metadata row inside a
 *  bordered card). Used while fetching the corresponding list. */
export function ListRowSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="flex flex-col gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <li
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border-soft bg-panel p-4"
        >
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-48" />
          </div>
          <Skeleton className="h-4 w-4 rounded-sm" />
        </li>
      ))}
    </ul>
  );
}
