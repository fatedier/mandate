import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ChevronRight } from "lucide-react";
import type { MemoryEntryDto, MemoryEntryHistoryResponse } from "@shared/api-contracts";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { CopyButton } from "@/components/CopyButton";
import { api } from "@/lib/api-paths";
import { readJson } from "@/lib/api-json";
import { featureHref, threadHref } from "@/lib/feature-href";
import { formatDateTimeTitle, formatRelativeTime } from "@/lib/format";
import { errorText } from "@shared/error-text";
import { memoryLastUpdate } from "@shared/memory-last-update";
import { entryLocation, SOURCE_LABEL } from "./memory-entry";

export function MemoryDetailDialog({
  entry,
  open,
  onOpenChange,
  resolveProject
}: {
  entry: MemoryEntryDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resolveProject?: (projectId: string) => string | undefined;
}) {
  const history = useEntryHistory(open ? entry?.id ?? null : null);
  const stated = typeof entry?.metadata?.statedAt === "string" ? entry.metadata.statedAt : entry?.source === "user" ? entry.createdAt : null;
  const before = entry ? memoryLastUpdate(entry)?.previous.content : undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-border-soft px-5 py-4">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            {entry && <EntryLine entry={entry} resolveProject={resolveProject} />}
          </DialogTitle>
          {entry && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-chrome">
              <span>
                {SOURCE_LABEL[entry.source]}
                <Stamp label="created" value={entry.createdAt} />
                {stated && <Stamp label="stated" value={stated} />}
                <Stamp label="updated" value={entry.updatedAt} />
              </span>
              <span className="font-mono" title={entry.id}>
                {entry.id.slice(0, 12)}
              </span>
            </div>
          )}
        </DialogHeader>
        {entry && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <Section
              title="memory"
              action={<CopyButton text={entry.content} label="Copy memory" className="-my-1" />}
            >
              {/* Prose, not a monospace block: these are paragraphs of English
                  and Chinese. Mono is this app's signal for machine ids. */}
              <p className="whitespace-pre-wrap rounded-sm border border-border-soft bg-panel px-3 py-2.5 text-sm leading-relaxed text-foreground/90">
                {entry.content}
              </p>
            </Section>
            {before !== undefined && (
              <Section title="before the last update">
                <p data-slot="memory-before-update" className="whitespace-pre-wrap rounded-sm border border-border-soft px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
                  {before}
                </p>
              </Section>
            )}
            {entry.userQuote && (
              <Section title="in your words">
                <p className="text-sm leading-relaxed text-foreground/90">“{entry.userQuote}”</p>
              </Section>
            )}
            {history.data?.sourceThread && (
              <Section title="from">
                <SourceThreadLink thread={history.data.sourceThread} />
              </Section>
            )}
            <Section title="history">
              {history.error ? (
                <p className="text-xs text-destructive">{history.error}</p>
              ) : !history.data ? (
                <p className="text-xs text-faint">Loading…</p>
              ) : (
                <ol data-slot="memory-history" className="divide-y divide-border-soft rounded-md border border-border-soft">
                  {history.data.events.map((event, index) => (
                    <li key={`${event.at}-${index}`} className="flex gap-3 px-3 py-2">
                      <span className="w-20 shrink-0 text-2xs text-chrome" title={formatDateTimeTitle(event.at) || undefined}>
                        {formatRelativeTime(event.at)}
                      </span>
                      {/* A reason may hold a hash or a path with no place to break. */}
                      <span className="min-w-0 break-words text-xs leading-relaxed text-foreground">
                        {event.text}
                        {event.detail && <span className="block text-2xs text-chrome">{event.detail}</span>}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The memory's story, read when its dialog opens. */
function useEntryHistory(id: string | null) {
  const [state, setState] = useState<{ id: string | null; data: MemoryEntryHistoryResponse | null; error: string }>(
    { id: null, data: null, error: "" }
  );
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    // Deferred by a zero timer like the rest of this page: no state set during the commit.
    const timer = window.setTimeout(() => {
      fetch(api.memoryEntryHistory(id), { signal: controller.signal })
        .then((res) => readJson<MemoryEntryHistoryResponse>(res))
        .then((data) => setState({ id, data, error: "" }))
        .catch((err) => {
          if ((err as Error)?.name !== "AbortError") setState({ id, data: null, error: errorText(err) });
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [id]);
  // A previous memory's history is not this one's.
  return state.id === id ? state : { id, data: null, error: "" };
}

function SourceThreadLink({ thread }: { thread: NonNullable<MemoryEntryHistoryResponse["sourceThread"]> }) {
  const target = thread.scope === "worker" && thread.projectSlug && thread.featureSlug
    ? { href: featureHref(thread.projectSlug, thread.featureSlug), label: `${thread.featureName ?? "worker"} (worker)` }
    : thread.scope === "global"
      ? { href: "/agent", label: "Your agent" }
      : { href: threadHref(thread.id), label: thread.title ?? "A manager thread" };
  // An archived thread or worker has no page to open, and its worker's
  // slug may since name another worker.
  if (thread.archived) {
    return <span data-slot="memory-source" className="text-sm text-muted-foreground">{target.label} (archived)</span>;
  }
  return (
    <Link
      data-slot="memory-source"
      to={target.href}
      className="hit relative inline-flex items-center gap-1 text-sm text-foreground underline decoration-border underline-offset-[3px] hover:text-muted-foreground"
    >
      {target.label}
      <ChevronRight aria-hidden className="size-3" />
    </Link>
  );
}

function Stamp({ label, value }: { label: string; value: string }) {
  return (
    <span data-slot="memory-stamp" title={formatDateTimeTitle(value) || undefined}>
      {" · "}
      {label} {formatRelativeTime(value)}
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

/** The type is a category, not a status, so it takes the neutral pill: the
 *  word carries the distinction, and colour stays for things that need
 *  acting on. */
export function TypeBadge({ type }: { type: MemoryEntryDto["type"] }) {
  return <span className="pill pill-neutral">{type}</span>;
}

/** A memory's type, where it lives, and whether it is archived, said one way
 *  in its Browse row and its detail's header (the header had its own
 *  uppercase scope chip, struck through when archived). The type badge
 *  carries the type and the location where it came from, so neither word is
 *  printed twice. */
export function EntryLine({
  entry,
  resolveProject
}: {
  entry: MemoryEntryDto;
  resolveProject?: (projectId: string) => string | undefined;
}) {
  return (
    // `contents`: its parts are the caller's own flex items, as they were in
    // the Browse row, so a long location wraps there as it always did.
    <span data-slot="memory-entry-line" className="contents">
      <TypeBadge type={entry.type} />
      <span className="min-w-0 truncate text-2xs text-chrome">{entryLocation(entry, resolveProject)}</span>
      {entry.status === "archived" && <span className="shrink-0 text-2xs text-chrome line-through">archived</span>}
    </span>
  );
}
