import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/format";

export function RelativeTime({ value }: { value: unknown }) {
  return formatRelativeTime(value, useNow());
}
