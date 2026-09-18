import { Section, SectionRow } from "@/components/Section";
import { Skeleton } from "@/components/ui/skeleton";

/** One header line over six 40px rows: the shape a list (the log, the
 *  breakdown table) will have once it loads, so nothing jumps when it does. */
export function ActivityListSkeleton() {
  return (
    <Section title={<Skeleton className="h-3 w-24 rounded-xs bg-sel" />}>
      {Array.from({ length: 6 }, (_, i) => (
        <SectionRow key={i} minH="40">
          <Skeleton className="h-3.5 w-[85%] rounded-xs bg-sel" />
        </SectionRow>
      ))}
    </Section>
  );
}

/** Header lines + panels in --sel: the shape the Overview will have. */
export function ActivitySkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Section title={<Skeleton className="h-3 w-16 rounded-xs bg-sel" />}>
        <div className="flex flex-col gap-3 p-3.5">
          <Skeleton className="h-6 w-64 rounded-xs bg-sel" />
          <Skeleton className="h-40 w-full rounded-xs bg-sel" />
        </div>
      </Section>
      <Section title={<Skeleton className="h-3 w-32 rounded-xs bg-sel" />}>
        <div className="flex flex-col gap-3 p-3.5">
          <Skeleton className="h-3.5 w-[90%] rounded-xs bg-sel" />
          <Skeleton className="h-3.5 w-[70%] rounded-xs bg-sel" />
          <Skeleton className="h-3.5 w-[55%] rounded-xs bg-sel" />
        </div>
      </Section>
    </div>
  );
}
