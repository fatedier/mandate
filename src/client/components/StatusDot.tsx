import { cn } from "@/lib/utils";
import type { WindowStatus } from "@/lib/snapshot-types";

interface StatusDotProps {
  status: WindowStatus | undefined;
  className?: string;
}

export function StatusDot({ status, className }: StatusDotProps) {
  const resolved = status ?? "unknown";
  return (
    <span
      className={cn(
        "block h-2 w-2 rounded-full bg-current",
        `status-${resolved}`,
        className
      )}
      aria-hidden="true"
    />
  );
}
