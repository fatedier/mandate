import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { PillTabs } from "@/components/PillTabs";
import { InlineError, LoadingLine } from "@/components/ViewState";
import { BottomSheet, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/useIsMobile";
import { copyTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { ShareCard } from "./ShareCard";
import { isPng, ShareImageRendererContext } from "./share-image";
import { shareMarkdown } from "./share-markdown";
import { canCopyImage, copyImage, saveSharedFile } from "./share-save";
import type { ShareItem } from "./share-selection";

type Format = "image" | "markdown";
const FORMATS: ReadonlyArray<{ id: Format; label: string }> = [
  { id: "image", label: "Image" },
  { id: "markdown", label: "Markdown" }
];

type Made = { status: "making" } | { status: "failed" } | { status: "ready"; blob: Blob; url: string };

/** What was picked, to take away: the image of it (drawn from a card off
 *  screen) or its Markdown, each to save and, where the page can, to copy.
 *  Done, it says so and `onDone`; closed, `onClose`. A dialog on a desktop,
 *  a sheet on a phone. */
export function ShareDialog({ items, onClose, onDone }: { items: readonly ShareItem[]; onClose: () => void; onDone: () => void }) {
  const isMobile = useIsMobile();
  const render = useContext(ShareImageRendererContext);
  const [format, setFormat] = useState<Format>("image");
  const [made, setMade] = useState<Made>({ status: "making" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const markdown = useMemo(() => shareMarkdown(items), [items]);
  // The clipboard's write is there only on a secure page; the text has the
  // browser's copy command everywhere.
  const [copiesImage] = useState(canCopyImage);

  // The image, once the card is drawn; again on Retry.
  useEffect(() => {
    const node = cardRef.current;
    if (!node) return;
    let alive = true;
    render(node)
      .then(async (blob) => {
        if (!(await isPng(blob))) throw new Error("the drawn image is not a PNG");
        return blob;
      })
      .then(
        (blob) => { if (alive) setMade({ status: "ready", blob, url: URL.createObjectURL(blob) }); },
        () => { if (alive) setMade({ status: "failed" }); }
      );
    return () => { alive = false; };
  }, [render, attempt]);
  useEffect(() => {
    if (made.status !== "ready") return;
    const url = made.url;
    return () => URL.revokeObjectURL(url);
  }, [made]);

  const run = async (action: () => Promise<boolean>, done: string, failed: string) => {
    setBusy(true);
    const ok = await action().catch(() => false);
    setBusy(false);
    if (!ok) {
      toast.error(failed);
      return;
    }
    toast.success(done);
    onDone();
  };
  const blob = made.status === "ready" ? made.blob : null;
  const saveImage = () => blob && void run(async () => { await saveSharedFile(blob, "png"); return true; }, "Image saved", "Couldn't save the file.");
  const copyTheImage = () => blob && void run(() => copyImage(blob), "Image copied", "Couldn't copy the image.");
  const saveText = () => void run(async () => {
    await saveSharedFile(new Blob([markdown], { type: "text/markdown;charset=utf-8" }), "md");
    return true;
  }, "File saved", "Couldn't save the file.");
  const copyText = () => void run(() => copyTextToClipboard(markdown), "Text copied", "Couldn't copy the text.");

  // The primary action is the copy where there is one; on a phone it fills the row.
  const action = (label: string, onClick: () => void, primary: boolean, disabled = false) => (
    <Button
      key={label}
      size="sm"
      variant={primary ? "default" : "outline"}
      className={cn(isMobile && primary && "flex-1")}
      disabled={busy || disabled}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  const actions = format === "image"
    ? [action("Save image", saveImage, !copiesImage, blob === null), ...(copiesImage ? [action("Copy image", copyTheImage, true, blob === null)] : [])]
    : [action("Save file", saveText, false), action("Copy text", copyText, true)];

  const body: ReactNode = format === "image" ? (
    made.status === "ready" ? (
      <img src={made.url} alt="" data-slot="share-image" className="mx-auto block h-auto w-[480px] max-w-full shadow-md" />
    ) : made.status === "failed" ? (
      <InlineError onRetry={() => { setMade({ status: "making" }); setAttempt((n) => n + 1); }}>Couldn't create the image. Try again.</InlineError>
    ) : (
      <LoadingLine />
    )
  ) : (
    <pre data-slot="share-markdown" className="select-text whitespace-pre-wrap font-mono text-xs leading-[1.6] text-foreground [overflow-wrap:anywhere]">{markdown}</pre>
  );
  const formats = <PillTabs items={FORMATS} value={format} onChange={setFormat} aria-label="Format" />;
  const content = (
    <>
      <div className={cn("min-h-0 flex-1 overflow-y-auto bg-sel", isMobile ? "p-3" : "p-5")}>{body}</div>
      <div className={cn("flex shrink-0 items-center gap-2 border-t border-border-soft px-4 py-3", !isMobile && "justify-end")}>{actions}</div>
    </>
  );
  // Off screen, in the page's theme: what the image is drawn from.
  const card = createPortal(
    <div aria-hidden className="pointer-events-none fixed top-0 left-[-10000px]">
      <ShareCard ref={cardRef} items={items} />
    </div>,
    document.body
  );

  const onOpenChange = (open: boolean) => { if (!open) onClose(); };
  if (isMobile) {
    return (
      <>
        {card}
        <BottomSheet
          open
          slot="share-dialog"
          onOpenChange={onOpenChange}
          fullOnly
          bodyClassName="flex flex-col"
          header={<div className="flex items-center gap-3 px-4 pb-2"><BottomSheetTitle>Share</BottomSheetTitle>{formats}</div>}
        >
          {content}
        </BottomSheet>
      </>
    );
  }
  return (
    <>
      {card}
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[min(720px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]" aria-describedby={undefined}>
          <div data-slot="share-dialog" className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border-soft pr-12 pl-4">
              <DialogTitle className="text-base">Share</DialogTitle>
              {formats}
            </div>
            {content}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
