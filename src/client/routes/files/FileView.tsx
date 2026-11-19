import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ImageViewer } from "@/components/ImageViewer";
import { MarkdownView } from "@/components/MarkdownView";
import { LoadingLine, StateMessage } from "@/components/ViewState";
import { CopyButton } from "@/components/CopyButton";
import { fileNameOf, type FileTarget } from "@/lib/file-link";
import { formatJson, isJsonName, JSON_COLOR_MAX_CHARS, jsonRuns, type JsonRun, type JsonTokenKind } from "@/lib/json-format";
import { formatByteSize, formatCalendarDate, formatClockMinutes } from "@/lib/format";
import { normalizeExternalHttpUrl, openExternalHttpUrl } from "@/lib/open-external";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import { buildFilePreviewSrcDoc } from "@/routes/canvas/canvas-srcdoc";
import { IMAGE_MAX_BYTES, TEXT_PART_BYTES, type FileDto } from "@shared/api-contracts";
import { FileFetchError, fetchFile, fileDownloadUrl, fileRawUrl, saveFileToDownloads } from "./file-api";

/** A text's lines are this tall, so a line's place is known without layout. */
const LINE_PX = 20;
const PART_SHOWN = `${TEXT_PART_BYTES / 1024 / 1024} MB`;

type Loaded = { key: string; dto: FileDto; read: number; error?: undefined } | { key: string; dto?: undefined; error: FileFetchError };

/** A file an agent linked, as the page shows it: in a panel's tab, over the
 *  page (a phone), or on its own page. Read when it opens, and again each time
 *  its tab is shown; not live. */
export function FileView({ target, presentation, onClose, shown = true, opened }: {
  target: FileTarget;
  presentation: "panel" | "dialog" | "page";
  /** How many times its tab was opened by a link: once more brings the
   *  linked lines back into view. */
  opened?: number;
  /** Its close button (over the page): one step back. */
  onClose?: () => void;
  /** A panel's tab in sight: it reads the file again when it comes back. */
  shown?: boolean;
}) {
  const lineKey = `${target.path}|${target.line ?? ""}|${target.end ?? ""}`;
  // The part of a large text asked for; a new link (or line) starts over.
  const [part, setPart] = useState<{ key: string; value: "start" | "end" } | null>(null);
  const asked = part?.key === lineKey ? part.value : null;
  const key = `${lineKey}|${asked ?? ""}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // Each reading is numbered: pictures shown ask for their bytes again.
  const reads = useRef(0);
  useEffect(() => {
    if (!shown) return;
    let live = true;
    const opts = asked ? { part: asked } : target.line !== undefined ? { line: target.line } : {};
    fetchFile(target.path, opts).then(
      (dto) => { if (live) setLoaded({ key, dto, read: (reads.current += 1) }); },
      (error: unknown) => { if (live) setLoaded({ key, error: error instanceof FileFetchError ? error : new FileFetchError(String(error), "network") }); }
    );
    return () => { live = false; };
  }, [key, shown, asked, target.path, target.line]);
  const current = loaded?.key === key ? loaded : null;
  const dto = current?.dto ?? null;
  // A whole JSON file, formatted; null for anything else (a part of one too).
  const formatted = useMemo(() => (dto?.kind === "text" && dto.text !== undefined && !dto.part && isJsonName(dto.name) ? formatJson(dto.text) : null), [dto]);
  // Markdown and HTML start as they read, JSON formatted, unless the link
  // names lines.
  const [mode, setMode] = useState<{ key: string; value: "preview" | "source" } | null>(null);
  const view = mode?.key === lineKey ? mode.value : target.line !== undefined ? "source" : "preview";
  const path = dto?.path ?? target.path;

  return (
    <div
      data-slot="file-view"
      data-path={target.path}
      data-line={target.line}
      data-end={target.end}
      data-presentation={presentation}
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-background"
    >
      <div data-slot="file-header" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-soft px-3 py-2">
        {/* The name and its time take what the controls leave: on a phone the
            time goes under the name, and the name truncates, before an icon
            leaves the row. */}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span data-slot="file-name" className="min-w-0 truncate text-sm font-semibold">{dto?.name ?? fileNameOf(target.path)}</span>
          {dto && <span data-slot="file-meta" className="num text-xs text-muted-foreground">{metaLine(dto, target)}</span>}
        </span>
        {dto && (dto.kind === "markdown" || dto.kind === "html" || formatted !== null) && (
          <span role="group" aria-label="View" className="inline-flex rounded-md bg-sel p-0.5">
            {(["preview", "source"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setMode({ key: lineKey, value })}
                className={cn("rounded-sm px-2 py-0.5 text-xs", view === value ? "bg-background font-medium text-foreground shadow-xs" : "text-muted-foreground")}
              >
                {value === "source" ? "Source" : formatted !== null ? "Formatted" : "Preview"}
              </button>
            ))}
          </span>
        )}
        <span className="flex shrink-0 items-center">
          {/* It says Copied itself, as every copy button does: a notice would be louder than the copy.
              Sized for touch as its neighbours are, with no wider area over Download's edge. */}
          <CopyButton text={path} label="Copy path" className={ICON_BUTTON} iconClassName="size-4" touchArea={false} />
          {dto && <DownloadFile path={dto.path} name={dto.name} />}
          {onClose && (
            <button type="button" aria-label="Close file" onClick={onClose} className="flex size-9 shrink-0 items-center justify-center rounded-md text-chrome hover:bg-sel sm:size-7">
              <X className="size-4" />
            </button>
          )}
        </span>
        <span data-slot="file-folder" className="basis-full font-mono text-[11px] leading-4 text-faint [overflow-wrap:anywhere]">{dto?.folder ?? folderOf(target.path)}</span>
      </div>
      {!current ? (
        <div className="p-4"><LoadingLine /></div>
      ) : current.error ? (
        <FileError error={current.error} />
      ) : (
        <FileBody dto={current.dto} read={current.read} opened={opened} target={target} view={view} formatted={formatted} onPart={(value) => setPart({ key: lineKey, value })} />
      )}
    </div>
  );
}

/** The header's icon buttons: named on hover and to a screen reader. */
const ICON_BUTTON = "flex size-9 shrink-0 items-center justify-center rounded-md text-chrome hover:bg-sel hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:size-7";

/** The file as it is, to keep: a download under its own name; in the desktop
 *  app, whose webview downloads nothing, a copy the server puts in Downloads. */
function DownloadFile({ path, name }: { path: string; name: string }) {
  const icon = <Download className="size-4" aria-hidden />;
  if (isTauriRuntime()) {
    const save = async () => {
      try {
        await saveFileToDownloads(path);
        toast.success("Saved to Downloads");
      } catch {
        toast.error("Couldn't save the file.");
      }
    };
    return <button type="button" data-slot="file-download" aria-label="Download" title="Download" onClick={() => void save()} className={ICON_BUTTON}>{icon}</button>;
  }
  return <a data-slot="file-download" href={fileDownloadUrl(path)} download={name} aria-label="Download" title="Download" className={ICON_BUTTON}>{icon}</a>;
}

function FileBody({ dto, read, opened, target, view, formatted, onPart }: {
  dto: FileDto; read: number; opened?: number; target: FileTarget; view: "preview" | "source";
  /** The file formatted, when it is JSON. */
  formatted: string | null;
  onPart: (part: "start" | "end") => void;
}) {
  if (dto.kind === "image") {
    if (dto.size > IMAGE_MAX_BYTES) return <Note title="This image is too large to show here." size={dto.size} />;
    const src = fileRawUrl(dto.path, read);
    return (
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <ImageViewer src={src} alt={dto.name} className="block max-w-full">
          <img data-slot="file-image" src={src} alt={dto.name} className="max-w-full rounded-md border border-border-soft" />
        </ImageViewer>
      </div>
    );
  }
  if (dto.kind === "pdf") {
    return (
      <div className="flex flex-col items-start gap-2 p-6 text-sm">
        <span className="text-muted-foreground">{formatByteSize(dto.size)}</span>
        <OpenInBrowser path={dto.path} />
      </div>
    );
  }
  if (dto.kind === "other" || dto.text === undefined) return <Note title="This kind of file can't be shown here." size={dto.size} />;
  const banner = dto.part ? <PartBanner dto={dto} target={target} onPart={onPart} /> : null;
  if (view === "preview" && dto.kind === "markdown") {
    return (
      <>
        {banner}
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3"><MarkdownView text={dto.text} base={dto.folder} read={read} /></div>
      </>
    );
  }
  if (view === "preview" && dto.kind === "html") {
    return (
      <>
        {banner}
        <iframe
          data-slot="file-html"
          title={dto.name}
          srcDoc={buildFilePreviewSrcDoc(dto.text)}
          sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      </>
    );
  }
  // Its own lines, not the file's: a line the link names is not marked.
  if (view === "preview" && formatted !== null) return <FormattedJson text={formatted} />;
  return (
    <>
      {banner}
      <CodeLines text={dto.text} firstLine={dto.firstLine ?? 1} line={target.line} end={target.end} opened={opened} />
    </>
  );
}

function FormattedJson({ text }: { text: string }) {
  const runs = useMemo(() => (text.length <= JSON_COLOR_MAX_CHARS ? jsonRuns(text) : null), [text]);
  return <CodeLines text={text} firstLine={1} runs={runs} />;
}

const TOKEN_CLASS: Record<JsonTokenKind, string> = {
  key: "text-syntax-key",
  string: "text-syntax-string",
  number: "text-syntax-number",
  literal: "text-syntax-literal"
};

/** A text's lines, numbered from the part's first line, never wrapped; the
 *  linked lines marked and scrolled into view. Two blocks of text, not a row
 *  per line: a part is up to 2 MB. `runs`, the text coloured by token (its
 *  plain runs take the faint colour of punctuation). */
function CodeLines({ text, firstLine, line, end, opened, runs }: { text: string; firstLine: number; line?: number; end?: number; opened?: number; runs?: JsonRun[] | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const count = body.split("\n").length;
  const numbers = Array.from({ length: count }, (_, i) => firstLine + i).join("\n");
  const from = line !== undefined ? line - firstLine : -1;
  const lines = line !== undefined ? (end ?? line) - line + 1 : 0;
  const marked = from >= 0 && from < count;
  useEffect(() => {
    if (marked && scroller.current) scroller.current.scrollTop = Math.max(0, (from - 3) * LINE_PX);
  }, [marked, from, text, opened]);
  return (
    <div ref={scroller} data-slot="file-code" className="relative min-h-0 flex-1 overflow-auto bg-code-bg font-mono text-xs" style={{ lineHeight: `${LINE_PX}px` }}>
      <div className="relative flex min-w-max py-2">
        {marked && (
          <div
            data-slot="file-highlight"
            data-line={line}
            data-end={end ?? line}
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bg-amber/20"
            style={{ top: 8 + from * LINE_PX, height: Math.min(lines, count - from) * LINE_PX }}
          />
        )}
        <pre data-slot="file-line-numbers" aria-hidden className="relative m-0 select-none px-3 text-right text-faint">{numbers}</pre>
        <pre data-slot="file-text" className={cn("relative m-0 whitespace-pre pr-4", runs && "text-faint")}>
          {runs ? runs.map(([piece, kind], i) => (kind ? <span key={i} data-token={kind} className={TOKEN_CLASS[kind]}>{piece}</span> : piece)) : body}
        </pre>
      </div>
    </div>
  );
}

function PartBanner({ dto, target, onPart }: { dto: FileDto; target: FileTarget; onPart: (part: "start" | "end") => void }) {
  const size = formatByteSize(dto.size);
  const line = target.line ?? dto.firstLine ?? 1;
  const words = dto.part === "end"
    ? `Showing the last ${PART_SHOWN} of ${size}`
    : dto.part === "around"
      ? `Showing ${PART_SHOWN} around line ${line.toLocaleString("en-US")} of ${size}`
      : `Showing the first ${PART_SHOWN} of ${size}`;
  return (
    <div data-slot="file-part" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-soft px-3 py-1.5 text-xs text-muted-foreground">
      <span>{words}</span>
      {dto.part !== "start" && <Button size="xs" variant="outline" onClick={() => onPart("start")}>Show the start</Button>}
      {dto.part !== "end" && <Button size="xs" variant="outline" onClick={() => onPart("end")}>Show the end</Button>}
    </div>
  );
}

/** A PDF in the browser's own viewer, in a new tab (the desktop app's
 *  browser). */
function OpenInBrowser({ path }: { path: string }) {
  const href = new URL(fileRawUrl(path), window.location.href).href;
  return (
    <Button asChild size="sm" variant="outline">
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          const url = isTauriRuntime() ? normalizeExternalHttpUrl(href) : null;
          if (!url) return;
          event.preventDefault();
          void openExternalHttpUrl(url);
        }}
      >
        Open in browser
      </a>
    </Button>
  );
}

function FileError({ error }: { error: FileFetchError }) {
  if (error.code === "missing") return <Message title="File not found">It may have been moved or deleted.</Message>;
  if (error.code === "outside") {
    return <Message title="This file is outside the folders Mandate shows.">Project folders, their worktrees, Mandate's resources and temporary folders can be opened.</Message>;
  }
  if (error.code === "folder") return <Message title="This is a folder.">Only files can be opened here.</Message>;
  return <div className="p-4"><StateMessage title="Couldn't open the file." detail={error.message} /></div>;
}

function Message({ title, children }: { title: string; children: ReactNode }) {
  return <div className="p-4"><StateMessage title={title}>{children}</StateMessage></div>;
}

function Note({ title, size }: { title: string; size: number }) {
  return <div className="p-4"><StateMessage title={title}>{formatByteSize(size)}</StateMessage></div>;
}

function metaLine(dto: FileDto, target: FileTarget): string {
  const today = new Date(dto.modifiedAt).toDateString() === new Date().toDateString();
  const when = today ? formatClockMinutes(dto.modifiedAt) : formatCalendarDate(dto.modifiedAt);
  const lines = target.line === undefined ? "" : target.end !== undefined ? ` · Lines ${target.line}–${target.end}` : ` · Line ${target.line}`;
  return `Modified ${when} · ${formatByteSize(dto.size)}${lines}`;
}

function folderOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}
