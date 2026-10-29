import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-[18px] rounded-[5px] text-[9.5px]",
  md: "size-7 rounded-lg text-xs",
  lg: "size-9 rounded-[10px] text-sm"
} as const;

/** A provider's or a model's mark: one letter on a quiet tile, never a
 *  brand logo. */
export function ProviderMark({ letter, size }: { letter: string; size: keyof typeof SIZES }) {
  return (
    <span
      aria-hidden
      data-slot="provider-mark"
      className={cn(
        "grid shrink-0 place-items-center border border-border-soft bg-sel font-semibold leading-none text-foreground",
        SIZES[size]
      )}
    >
      {letter}
    </span>
  );
}
