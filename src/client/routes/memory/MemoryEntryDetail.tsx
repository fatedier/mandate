import type { ReactNode } from "react";
import type { MemoryEntryDto } from "@shared/api-contracts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/CopyButton";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { entryNames, entryReason } from "./memory-entry";

export function MemoryDetailDialog({
  entry,
  open,
  onOpenChange
}: {
  entry: MemoryEntryDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const names = entry ? entryNames(entry) : {};
  const reason = entry ? entryReason(entry) : "";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border-soft px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {entry && <KindBadge kind={entry.kind} />}
            {entry && <ScopeBadge scope={entry.scope} archived={entry.status === "archived"} />}
            {names.project && (
              <span className="text-sm text-muted-foreground">
                {names.feature ? `${names.project} / ${names.feature}` : names.project}
              </span>
            )}
          </DialogTitle>
          {entry && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-chrome">
              {/* Recall and use are different counters and routinely disagree —
                  retrieved into context is not the same as actually used — so
                  they are reported separately rather than merged into one. */}
              <span>
                recalled <span className="num text-muted-foreground">{entry.recallCount}×</span>
                {entry.lastRecalledAt ? `, last ${formatRelativeTime(entry.lastRecalledAt)}` : ""}
              </span>
              <span>
                used <span className="num text-muted-foreground">{entry.useCount}×</span>
              </span>
              <span>strength {entry.strength.toFixed(2)}</span>
              <span>confidence {entry.confidence.toFixed(2)}</span>
              <span className="font-mono" title={entry.id}>
                {entry.id.slice(0, 12)}
              </span>
            </div>
          )}
        </DialogHeader>
        {entry && (
          <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4">
            {reason && (
              <Section title="why it was kept">
                <p className="text-sm leading-relaxed text-foreground/90">{reason}</p>
              </Section>
            )}
            <Section
              title="memory"
              action={<CopyButton text={entry.content} label="Copy memory" className="-my-1" />}
            >
              {/* Prose, not a monospace block: these are paragraphs of English
                  and Chinese. Mono is this app's signal for machine ids. */}
              <p className="whitespace-pre-wrap rounded-sm border border-border-soft bg-card/40 px-3 py-2.5 text-sm leading-relaxed text-foreground/90">
                {entry.content}
              </p>
            </Section>
            {entry.cues.length > 0 && (
              <Section title={`cues · ${entry.cues.length}`}>
                {/* Every cue, not the first five: these are what recall matches
                    on, so a hidden one is a silent reason the memory surfaced. */}
                <div className="flex flex-wrap gap-1.5">
                  {entry.cues.map((cue, i) => (
                    <span
                      key={`${cue}-${i}`}
                      className="rounded-xs border border-border-soft bg-background/40 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {cue}
                    </span>
                  ))}
                </div>
              </Section>
            )}
            {Object.keys(entry.feedback ?? {}).length > 0 && (
              <Section title="feedback">
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  {Object.entries(entry.feedback ?? {}).map(([k, v]) => (
                    <span key={k}>
                      {k}: <span className="num text-foreground/80">{v}</span>
                    </span>
                  ))}
                </div>
              </Section>
            )}
            <Section title="lifecycle">
              <div className="grid gap-x-6 gap-y-1 text-xs text-chrome sm:grid-cols-2">
                <Stamp label="created" value={entry.createdAt} />
                <Stamp label="updated" value={entry.updatedAt} />
                <Stamp label="last recalled" value={entry.lastRecalledAt} />
                <Stamp label="last used" value={entry.lastUsedAt} />
                <span>
                  source: <span className="font-mono text-muted-foreground">{entry.source}</span>
                </span>
              </div>
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stamp({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <span title={value}>
      {label}: <span className="text-muted-foreground">{formatRelativeTime(value)}</span>
    </span>
  );
}

function Section({
  title,
  action,
  children
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="label-micro text-chrome">{title}</div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function KindBadge({ kind }: { kind: MemoryEntryDto["kind"] }) {
  const tone: Record<MemoryEntryDto["kind"], string> = {
    episodic: "border-phase-design/30 bg-phase-design/10 text-phase-design",
    semantic: "border-phase-working/30 bg-phase-working/10 text-phase-working",
    preference: "border-phase-done/30 bg-phase-done/10 text-phase-done",
    procedural: "border-amber/30 bg-amber/10 text-amber"
  };
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-xs border px-1.5 label-micro",
        tone[kind]
      )}
    >
      {kind}
    </span>
  );
}

export function ScopeBadge({
  scope,
  archived
}: {
  scope: MemoryEntryDto["scope"];
  archived: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-xs border border-border-soft bg-background/40 px-1.5 label-micro text-muted-foreground",
        archived && "line-through"
      )}
    >
      {scope}
    </span>
  );
}
