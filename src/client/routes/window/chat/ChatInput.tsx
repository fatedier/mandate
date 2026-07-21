import { memo, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { Clock3, Send, Mic, ImagePlus, Square, X, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DISABLE_TEXT_ASSIST_PROPS } from "@/lib/input-assist";
import { cn } from "@/lib/utils";
import { useVoiceStore } from "@/store/voice";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useAgentChatStore, scopeKey, type AgentChatScope, type PendingMessage } from "@/store/agent-chat";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import { imageAttachmentSrc } from "./attachments";

interface ChatInputProps {
  /** Current chat scope. Used to match one-shot ref attachments in the store. */
  scope?: AgentChatScope;
  onSend: (
    content: string,
    attachments?: AgentMessageAttachment[],
    workItemRef?: { itemId: string; snapshotAt: string }
  ) => void;
  onCancel?: () => void;
  busyHint?: boolean;
  /** When true, render a mic button next to send. Click → enter voice mode. */
  showMicButton?: boolean;
  queuedMessages?: PendingMessage[];
  onDeleteQueuedMessage?: (localId: string) => void;
}

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const INPUT_MIN_HEIGHT_PX = 56;
const INPUT_MAX_LINES = 8;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const ChatInput = memo(function ChatInput({
  scope, onSend, onCancel, busyHint, showMicButton, queuedMessages = [], onDeleteQueuedMessage
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<AgentMessageAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const closeDrawer = useAgentChatStore((s) => s.closeDrawer);
  const pendingChatRef = useAgentChatStore((s) => s.pendingChatRef);
  const clearChatRef = useAgentChatStore((s) => s.clearChatRef);
  const isMobile = useIsMobile();
  const hasQueued = queuedMessages.length > 0;

  // Local mirror of the pending ref so this input "captures" it once on
  // mount/scope-match — even after a ✕ cancel we don't re-pickup from store.
  const [attachedRef, setAttachedRef] = useState<
    { itemId: string; title: string; snapshotAt: string } | null
  >(null);
  useEffect(() => {
    if (!pendingChatRef || !scope) return;
    if (scopeKey(pendingChatRef.scope) !== scopeKey(scope)) return;
    const ref = pendingChatRef.ref;
    const frame = requestAnimationFrame(() => {
      setAttachedRef(ref);
      clearChatRef();
      taRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingChatRef, scope, clearChatRef]);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
    const maxHeight = lineHeight * INPUT_MAX_LINES + 16;
    ta.style.height = `${Math.max(INPUT_MIN_HEIGHT_PX, Math.min(ta.scrollHeight, maxHeight))}px`;
  }, [value]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed && attachments.length === 0) return;
    const ref = attachedRef
      ? { itemId: attachedRef.itemId, snapshotAt: attachedRef.snapshotAt }
      : undefined;
    onSend(trimmed, attachments, ref);
    setValue("");
    setAttachments([]);
    setAttachmentError("");
    setAttachedRef(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = value.trim().length > 0 || attachments.length > 0;
  const canCancel = Boolean(busyHint && onCancel && !canSend);

  const addFiles = async (files: File[]) => {
    setAttachmentError("");
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    if (attachments.length + imageFiles.length > MAX_IMAGE_ATTACHMENTS) {
      setAttachmentError(`Attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      return;
    }
    try {
      const next = await Promise.all(imageFiles.map(readImageAttachment));
      setAttachments((current) => [...current, ...next]);
    } catch (err) {
      setAttachmentError(err instanceof Error ? err.message : String(err));
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  return (
    <div
      className="flex flex-col gap-1 border-t border-border-soft bg-card pt-1.5"
      style={{
        paddingLeft: "max(env(safe-area-inset-left), 0.75rem)",
        paddingRight: "max(env(safe-area-inset-right), 0.75rem)",
        paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)"
      }}
    >
      {hasQueued && (
        <div className="rounded-lg border border-dashed border-primary/35 bg-primary/5 px-2.5 py-2">
          <div className="flex items-center gap-1.5 label-micro text-chrome">
            <Clock3 className="h-3 w-3" />
            <span>Queued</span>
            <span className="text-muted-foreground/70">{queuedMessages.length}</span>
          </div>
          <div className="mt-1.5 flex max-h-24 flex-col gap-1 overflow-y-auto scrollbar-thin">
            {queuedMessages.map((message) => (
              <QueuedMessageLine
                key={message.localId}
                message={message}
                onDelete={onDeleteQueuedMessage}
              />
            ))}
          </div>
        </div>
      )}
      {attachedRef && (
        <div className="flex items-center gap-1.5 px-1">
          <span className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-phase-design/12 text-phase-design border border-phase-design/25">
            <Pin className="h-3 w-3" />
            <span className="font-medium truncate max-w-[280px]">re: {attachedRef.title}</span>
            <button
              type="button"
              aria-label="Remove work item reference"
              onClick={() => setAttachedRef(null)}
              className="ml-0.5 rounded-full hover:bg-phase-design/20 p-0.5"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="flex max-h-28 gap-2 overflow-x-auto px-1 pb-1 scrollbar-thin">
          {attachments.map((attachment) => (
            <div key={attachment.id} className="relative h-20 w-20 shrink-0 overflow-hidden rounded-md border border-border-soft bg-muted">
              <img
                src={imageAttachmentSrc(attachment)}
                alt={attachment.name || "Attached image"}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                aria-label="Remove image"
                className="absolute right-1 top-1 rounded-full bg-background/90 p-0.5 text-foreground shadow-sm"
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && (
        <div className="px-1 text-2xs text-destructive">{attachmentError}</div>
      )}
      <div className="flex flex-col rounded-lg border border-border-soft bg-background px-3 py-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? []);
            e.currentTarget.value = "";
            void addFiles(files);
          }}
        />
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => {
            window.setTimeout(() => {
              composingRef.current = false;
            }, 0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder="Message the agent…"
          {...DISABLE_TEXT_ASSIST_PROPS}
          className="w-full resize-none bg-transparent border-0 outline-none text-base leading-[1.5] placeholder:text-muted-foreground py-1 overflow-y-auto scrollbar-thin"
          style={{
            minHeight: INPUT_MIN_HEIGHT_PX,
            maxHeight: `calc(${INPUT_MAX_LINES}lh + 1rem)`
          }}
        />
        <div className="mt-1 flex items-center justify-end gap-1">
          {showMicButton && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                setVoiceMode(true);
                if (isMobile) closeDrawer();
              }}
              aria-label="Start voice"
              className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
            >
              <Mic className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach image"
            title="Attach image"
            className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
          >
            <ImagePlus className="h-4 w-4" />
          </Button>
          {canCancel ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label="Stop agent"
              title="Stop agent"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          ) : (
            <Button
              variant="default"
              size="icon"
              disabled={!canSend}
              onClick={submit}
              aria-label="Send message"
              title="Send message"
              className={cn("h-9 w-9 shrink-0", !canSend && "opacity-50")}
            >
              <Send className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );

  function isImeComposing(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    const nativeEvent = e.nativeEvent as KeyboardEvent["nativeEvent"] & {
      isComposing?: boolean;
      keyCode?: number;
    };
    return composingRef.current || nativeEvent.isComposing === true || nativeEvent.keyCode === 229;
  }
});

function QueuedMessageLine({
  message,
  onDelete
}: {
  message: PendingMessage;
  onDelete?: (localId: string) => void;
}) {
  const attachmentCount = message.attachments?.length ?? 0;
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md bg-background/70 px-2 py-1 text-xs text-foreground/90">
      <div className="min-w-0 flex-1 truncate">
        {message.content || "(image)"}
        {attachmentCount > 0 && (
          <span className="ml-1 text-muted-foreground">
            +{attachmentCount} image{attachmentCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {onDelete && (
        <button
          type="button"
          aria-label="Remove queued message"
          title="Remove queued message"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={() => onDelete(message.localId)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

async function readImageAttachment(file: File): Promise<AgentMessageAttachment> {
  if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
    throw new Error("Supported image types: PNG, JPEG, WebP, GIF.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image must be ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB or smaller.`);
  }
  const dataUrl = await readDataUrl(file);
  const parsed = parseDataUrl(dataUrl);
  if (!parsed || !SUPPORTED_IMAGE_TYPES.has(parsed.mediaType)) {
    throw new Error("Could not read image data.");
  }
  return {
    type: "image",
    id: `img-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`,
    name: file.name,
    mediaType: parsed.mediaType,
    data: parsed.base64,
    sizeBytes: file.size
  };
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

function parseDataUrl(value: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(value);
  if (!match) return null;
  return { mediaType: match[1]!.toLowerCase(), base64: match[2] ?? "" };
}

