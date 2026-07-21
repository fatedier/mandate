import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Machine-identifier chip (slugs, paths, branches) — always mono. */
export function SlugChip({ children, title, className }: {
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "shrink-0 rounded-md border border-border-soft bg-background/60 px-1.5 py-0.5 font-mono text-2xs text-faint",
        className
      )}
    >
      {children}
    </span>
  );
}
