import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Clock3, Send, Mic, ImagePlus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DISABLE_TEXT_ASSIST_PROPS } from "@/lib/input-assist";
import { cn } from "@/lib/utils";
import { useVoiceStore } from "@/store/voice";
import { useGlobalAgentStore } from "@/store/global-agent";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useEnterToSend } from "@/hooks/useEnterToSend";
import { useAnsweringAbove } from "./useAnsweringAbove";
import type { AgentChatScope, PendingMessage } from "@/store/agent-chat";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { AgentCommandDto, AgentCommandState } from "@shared/api-contracts";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { CommandList } from "./CommandList";
import { ComposerList } from "./ComposerList";
import { LastShown } from "@/components/Shown";
import { composerOptionId } from "./composer-option-id";
import { mentionQueryAt } from "./mention-draft";
import { mentionOptionKey, useMentionGroups } from "./mention-sources";
import type { Mention } from "@shared/mentions";
import { picksInText, shiftPicks } from "./mention-picks";
import { commandMatches, commandOfDraft, commandOptionId } from "./command-draft";
import { imageAttachmentSrc } from "./attachments";
import { scopeKey } from "@/store/agent-chat-utils";
import { errorText } from "@shared/error-text";
import { CHAT_COLUMN_MAX_PX, CHAT_GUTTER_CLASS } from "./chat-column";
import { INPUT_MAX_LINES, INPUT_MIN_HEIGHT_PX, useAutoFitTextarea, useConversationDraft } from "./composer-hooks";

interface ChatInputProps {
  /** Current chat scope: picks the placeholder. */
  scope?: AgentChatScope;
  /** A send that can fail returns its promise: the draft stays, and nothing
   *  more sends, until it lands (Home's new thread keeps its text if the
   *  thread could not be started). */
  onSend: (content: string, attachments?: AgentMessageAttachment[], mentions?: Mention[]) => unknown;
  onCancel?: () => void;
  busyHint?: boolean;
  queuedMessages?: PendingMessage[];
  onDeleteQueuedMessage?: (localId: string) => void;
  /** "inline": the composer alone, in a page that lays it out itself (Home);
   *  "dock" (default): docked under a transcript, on its column. */
  layout?: "dock" | "inline";
  /** Overrides the scope's placeholder. */
  placeholder?: string;
  /** The send button's name (default "Send message"). */
  sendLabel?: string;
  textareaId?: string;
  autoFocus?: boolean;
  /** Each new value puts the cursor in the composer (autoFocus only works on mount). */
  focusKey?: string;
  /** The commands this conversation's server offers. Absent: every draft is a
   *  message (Home's composer, or a list that has not arrived). */
  commands?: readonly AgentCommandDto[];
  /** What the conversation is doing: which commands the list greys. */
  commandState?: AgentCommandState;
  /** A draft whose first word is one of `commands`: handed over whole, with
   *  its attachment count, instead of onSend. Resolves true when it was taken
   *  (the draft clears); false is a refusal and the draft stays. */
  onCommand?: (text: string, attachments: number) => Promise<boolean>;
  /** Every keystroke and every send: what a line above the composer goes at. */
  onDraftInput?: () => void;
  /** What stands over the composer on its column, under a transcript (the
   *  questions that wait for an answer). Memoised by the caller: a new node
   *  draws the composer again. */
  above?: ReactNode;
  /** Typing @ picks a thread to mention (Your agent's, a manager thread's
   *  and Home's composers): the one typed in is not offered. Absent: no @
   *  list (a worker's). Memoised by the caller. */
  mentions?: { excludeId: string | null };
  /** What the toolbar holds after its own buttons (the thread's model).
   *  Memoised by the caller. */
  tools?: ReactNode;
}

const MAX_IMAGE_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const ChatInput = memo(function ChatInput({
  scope, onSend, onCancel, busyHint, queuedMessages = [], onDeleteQueuedMessage,
  layout = "dock", placeholder: placeholderOverride, sendLabel = "Send message", textareaId, autoFocus, focusKey,
  commands, commandState, onCommand, onDraftInput, above, mentions: mentionTarget, tools
}: ChatInputProps) {
  const draftKey = scope ? scopeKey(scope) : null;
  const { value, setValue, attachments, setAttachments, mentions: picks, setMentions: setPicks } = useConversationDraft(draftKey);
  const [attachmentError, setAttachmentError] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const startVoice = useVoiceStore((s) => s.startVoice);
  // Voice is the global agent's: its composer carries the mic, once set up.
  const voiceConfigured = useGlobalAgentStore((s) => s.agent?.voiceConfigured ?? false);
  const showMic = scope?.type === "global" && voiceConfigured;
  const isMobile = useIsMobile();
  // A field above the composer being typed in: on a touch screen the
  // composer steps aside for it (globals.css).
  const aboveRef = useRef<HTMLDivElement>(null);
  const answering = useAnsweringAbove(aboveRef, Boolean(above));
  const hasQueued = queuedMessages.length > 0;
  const placeholder = placeholderOverride ?? composerPlaceholder(scope);
  const [sending, setSending] = useState(false);
  // Images still being read: they belong to the message, so it waits for
  // them (Home's send clears its draft when it lands, a late image with it).
  const [reads, setReads] = useState(0);
  // The command list: open for the text that was just typed here, while that
  // is "/" and the start of some command's name. So Esc shuts it until the
  // next keystroke, and a draft the box comes back with, or another
  // conversation's, opens nothing by itself.
  const listId = useId();
  const composerRef = useRef<HTMLDivElement>(null);
  const [pick, setPick] = useState(0);
  const [listFor, setListFor] = useState<string | null>(null);
  const [listKey, setListKey] = useState(draftKey);
  // The @ list: open, as the command list is, for the text just typed here,
  // while the caret is in an @ and some thread matches.
  const [mentionFor, setMentionFor] = useState<string | null>(null);
  const [mentionPick, setMentionPick] = useState(0);
  const [caret, setCaret] = useState(0);
  if (listKey !== draftKey) {
    setListKey(draftKey);
    setListFor(null);
    setMentionFor(null);
  }
  // A command on its way to the server. The box stays live meanwhile
  // (disabling it would drop the cursor), but nothing else is sent.
  const [commandPending, setCommandPending] = useState(false);
  const matches = commands && onCommand && value === listFor ? commandMatches(value, commands) : [];
  const pickedIndex = Math.min(pick, matches.length - 1);
  const picked = matches[pickedIndex];
  const mentionAt = mentionTarget && value === mentionFor ? mentionQueryAt(value, caret) : null;
  const mentionGroups = useMentionGroups(mentionAt?.query ?? null, mentionTarget?.excludeId ?? null);
  const mentionOptions = mentionGroups.flatMap((group) => group.options);
  // The command list comes first: a draft starting "/" shows commands.
  const showMentions = !picked && mentionOptions.length > 0;
  const mentionIndex = Math.min(mentionPick, mentionOptions.length - 1);
  const pickedMention = showMentions ? mentionOptions[mentionIndex] : undefined;
  const listOpen = Boolean(picked) || showMentions;
  // Where the caret goes once a pick has rewritten the text: each pick asks
  // once, applied after its render (a pick may leave the text as it was).
  const [caretRequest, setCaretRequest] = useState<{ at: number } | null>(null);
  useLayoutEffect(() => {
    if (caretRequest) taRef.current?.setSelectionRange(caretRequest.at, caretRequest.at);
  }, [caretRequest]);
  // What the box holds now, for a command's answer that comes back later.
  const valueNow = useRef(value);
  useLayoutEffect(() => { valueNow.current = value; }, [value]);
  /** Writes the picked thread's "@<title>" in place of the query, one space
   *  after it (none added before whitespace), the caret past that space. */
  const pickMention = (key: string) => {
    const option = mentionOptions.find((o) => mentionOptionKey(o.mention) === key);
    if (!option || !mentionAt) return;
    const before = value.slice(0, mentionAt.start);
    const after = value.slice(caret);
    const written = `${before}@${option.mention.label}${/^\s/.test(after) ? "" : " "}`;
    const at = written.length + (/^\s/.test(after) ? 1 : 0);
    const next = written + after;
    const queryStart = mentionAt.start;
    const queryEnd = caret;
    setValue(next);
    // The query's words, and any pick they were part of, give way to the
    // pick; the rest move with the text. What the pick wrote ends at
    // `written` (a title can repeat the words after it).
    setPicks((current) => [
      ...shiftPicks(current.filter((p) => !(p.start < queryEnd && p.start + 1 + p.mention.label.length > queryStart)), value, next, written.length),
      { mention: option.mention, start: before.length }
    ]);
    setMentionFor(null);
    setMentionPick(0);
    setCaret(at);
    setCaretRequest({ at });
    taRef.current?.focus();
  };
  /** Puts a command in the box. It runs when it is sent, not here. */
  const fill = (name: string) => {
    setValue(name);
    setListFor(null);
    setPick(0);
    taRef.current?.focus();
  };

  useAutoFitTextarea(taRef, value);
  useEffect(() => {
    if (focusKey) taRef.current?.focus();
  }, [focusKey]);

  const hasDraft = value.trim().length > 0 || attachments.length > 0;
  const canSend = !sending && !commandPending && reads === 0 && hasDraft;
  const canCancel = Boolean(busyHint && onCancel && (sending || !hasDraft));

  const submit = () => {
    // Enter reaches here without the button: it sends only what Send would.
    if (!canSend) return;
    const trimmed = value.trim();
    const clear = () => {
      setValue("");
      setAttachments([]);
      setPicks([]);
      setAttachmentError("");
    };
    onDraftInput?.();
    if (commands && onCommand && commandOfDraft(trimmed, commands)) {
      // A command is not a message: the server runs it or refuses it, and a
      // refusal leaves the draft. Taken, its text goes, unless something else
      // was typed meanwhile (it had no images: a command with any is refused).
      const draft = value;
      // Sent: the list has done its part. What the command answers is said
      // on the line above the box, where an open list would lie over it.
      setListFor(null);
      setCommandPending(true);
      onCommand(trimmed, attachments.length)
        .then((taken) => {
          // Taken with the box as it was sent: it empties, and what it named goes with it.
          if (taken && valueNow.current === draft) {
            setValue("");
            setPicks([]);
          }
        }, () => {})
        .finally(() => setCommandPending(false));
      return;
    }
    // Where each pick stands in the box as it is, before the trim.
    const result = onSend(trimmed, attachments, mentionTarget ? picksInText(value, picks) : undefined);
    if (!(result instanceof Promise)) return clear();
    setSending(true);
    result.then(clear, () => {}).finally(() => setSending(false));
  };

  const { enterSends, isComposing, textareaProps: enterProps } = useEnterToSend(submit);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickedMention && !isComposing(e.nativeEvent)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setMentionPick((mentionIndex + (e.key === "ArrowDown" ? 1 : mentionOptions.length - 1)) % mentionOptions.length);
        return;
      }
      if ((e.key === "Tab" && !e.shiftKey) || (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        pickMention(mentionOptionKey(pickedMention.mention));
        return;
      }
    }
    if (picked && !isComposing(e.nativeEvent)) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((pickedIndex + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        fill(picked.name);
        return;
      }
      // Enter sends what is in the box. A part of a command is completed
      // first, so "/c" Enter never runs anything: a compaction cannot be
      // undone and asks no confirmation.
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey && value !== picked.name) {
        e.preventDefault();
        fill(picked.name);
        return;
      }
    }
    enterProps.onKeyDown(e);
  };

  const addFiles = async (files: File[]) => {
    // A message already on its way has its images; one added now would be
    // cleared with the draft when it lands, never sent.
    if (sending) return;
    setAttachmentError("");
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    if (attachments.length + imageFiles.length > MAX_IMAGE_ATTACHMENTS) {
      setAttachmentError(`Attach up to ${MAX_IMAGE_ATTACHMENTS} images.`);
      return;
    }
    setReads((count) => count + 1);
    try {
      const next = await Promise.all(imageFiles.map(readImageAttachment));
      setAttachments((current) => [...current, ...next]);
    } catch (err) {
      setAttachmentError(errorText(err));
    } finally {
      setReads((count) => count - 1);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    void addFiles(files);
  };

  const body = (
    <>
      {hasQueued && (
        <div className="rounded-sm border border-dashed border-border bg-panel px-2.5 py-2">
          <div className="flex items-center gap-1.5 label-micro text-chrome">
            <Clock3 className="h-3 w-3" />
            <span>Queued</span>
            <span className="text-muted-foreground/70">{queuedMessages.length}</span>
          </div>
          {/* On a touch screen each line is 44px with a 44px remove at its
              end, and the list still shows three before it scrolls. */}
          <div className="mt-1.5 flex max-h-24 flex-col gap-1 overflow-y-auto pointer-coarse:max-h-36">
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
      {attachments.length > 0 && (
        <AttachmentThumbnails
          attachments={attachments}
          onRemove={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
        />
      )}
      {attachmentError && (
        <div className="px-1 text-2xs text-destructive">{attachmentError}</div>
      )}
      <Popover open={listOpen} onOpenChange={(open) => { if (!open) { setListFor(null); setMentionFor(null); } }}>
        <PopoverAnchor asChild>
          <div ref={composerRef} data-slot="composer" className="flex flex-col rounded-xl border border-border bg-panel px-4 pt-3 pb-2.5 shadow-composer">
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
              id={textareaId}
              autoFocus={autoFocus}
              disabled={sending}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              // Every keystroke, one that leaves the text as it was among them
              // (a selection typed over): onChange is not told of those.
              onInput={(e) => {
                const typed = e.currentTarget.value;
                setListFor(typed);
                setPick(0);
                setMentionFor(typed);
                setMentionPick(0);
                setCaret(e.currentTarget.selectionStart);
                // A pick whose words this edit touched goes; the rest move
                // with the text. What the edit wrote ends where the caret landed.
                const wroteTo = e.currentTarget.selectionEnd;
                setPicks((current) => shiftPicks(current, value, typed, wroteTo));
                onDraftInput?.();
              }}
              // The caret moved without typing: the @ it is in decides the list.
              onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
              {...enterProps}
              onKeyDown={onKeyDown}
              aria-autocomplete={commands || mentionTarget ? "list" : undefined}
              aria-controls={picked || pickedMention ? listId : undefined}
              aria-activedescendant={picked
                ? commandOptionId(listId, picked.name)
                : pickedMention ? composerOptionId(listId, mentionOptionKey(pickedMention.mention)) : undefined}
              onPaste={onPaste}
              rows={1}
              placeholder={placeholder}
              {...DISABLE_TEXT_ASSIST_PROPS}
              className="w-full resize-none bg-transparent border-0 outline-none text-sm leading-[1.6] placeholder:text-faint py-0.5 overflow-y-hidden"
              style={{
                minHeight: INPUT_MIN_HEIGHT_PX,
                maxHeight: `calc(${INPUT_MAX_LINES}lh + 0.25rem)`
              }}
            />
            <div className="mt-2 flex items-center gap-0.5 pointer-coarse:gap-4">
              {showMic && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => startVoice()}
                  aria-label="Start voice"
                  className="shrink-0 text-chrome hover:text-foreground"
                >
                  <Mic className="h-4 w-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => fileRef.current?.click()}
                disabled={sending}
                aria-label="Attach image"
                title="Attach image"
                className="shrink-0 text-chrome hover:text-foreground"
              >
                <ImagePlus className="h-4 w-4" />
              </Button>
              {tools}
              <span className="flex-1" />
              {enterSends && <span className="mr-2 text-2xs text-faint">⏎ to send</span>}
              {canCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  aria-label="Stop agent"
                  title="Stop agent"
                  className="hit relative flex size-[30px] shrink-0 items-center justify-center rounded-full bg-sel text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Square className="h-3.5 w-3.5" fill="currentColor" />
                </button>
              ) : (
                <Button
                  variant="default"
                  size="icon-xs"
                  disabled={!canSend}
                  onClick={submit}
                  aria-label={sendLabel}
                  title={sendLabel}
                  // Nothing to send: the neutral fill Stop uses, at full strength —
                  // the accent at half strength read as nearly pressable.
                  className={cn("size-[30px] shrink-0 rounded-full", !canSend && "bg-sel text-faint disabled:opacity-100")}
                >
                  <Send className="size-3.5" />
                </Button>
              )}
            </div>
          </div>
        </PopoverAnchor>
        {/* Shut, it fades out as it was (its rows held, out of the
            pointer's way: !, over the inline pointer-events Radix sets in a
            modal sheet) while Radix plays its exit. */}
        <LastShown shown={listOpen}>
          {(picked || pickedMention) && (
            <PopoverContent
              side="top"
              // The commands, or what an @ can name: one list at a time.
              data-slot={picked ? "command-list" : "mention-list"}
              // As wide as the composer it belongs to.
              className="w-(--radix-popover-trigger-width) data-[state=closed]:pointer-events-none!"
              // The cursor stays in the textarea: the list is read from there.
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
              // Esc is the popover's: it shuts the list from wherever the focus
              // is. One that drops an IME candidate is the IME's (Safari sends it
              // as Escape): the list stays.
              onEscapeKeyDown={(event) => { if (isComposing(event)) event.preventDefault(); }}
              // The composer is the list's own anchor, not "outside" it.
              onInteractOutside={(event) => { if (composerRef.current?.contains(event.target as Node)) event.preventDefault(); }}
            >
              {picked
                ? <CommandList id={listId} commands={matches} picked={pickedIndex} state={commandState ?? "idle"} onPick={fill} />
                : (
                  <ComposerList
                    id={listId}
                    label="Mentions"
                    picked={mentionIndex}
                    rowClassName="items-center gap-2.5"
                    onPick={pickMention}
                    groups={mentionGroups.map((group) => ({
                      heading: group.heading,
                      options: group.options.map((o) => ({ key: mentionOptionKey(o.mention), content: o.content }))
                    }))}
                  />
                )}
            </PopoverContent>
          )}
        </LastShown>
      </Popover>
    </>
  );
  // Home lays the composer out itself; under a transcript it docks on the
  // transcript's column.
  if (layout === "inline") return <div className="flex flex-col gap-1.5">{body}</div>;

  return (
    // The transcript above keeps a scrollbar gutter whether or not it
    // scrolls (zero with overlay scrollbars), and centres its column in what
    // is left. This box reserves the same gutter (same scrollbar width) so
    // the composer centres on the same line and the edges meet (chat-column.ts).
    // It hides overflow, so it must not shrink below the composer: the
    // transcript gives up the height instead, as it did before the box.
    // With something above the composer the box may shrink, and only that
    // gives: on a short screen a tall question scrolls in what is left
    // rather than push the composer off it.
    <div data-slot="composer-box" data-answering={answering || undefined} className={cn("overflow-hidden bg-background [scrollbar-gutter:stable]", above ? "flex min-h-0 flex-col" : "shrink-0")}>
      <div
        className={cn("flex flex-col gap-1.5 bg-background pt-2", above && "min-h-0", CHAT_GUTTER_CLASS)}
        style={{
          // The transcript's gutter (CHAT_GUTTER_CLASS), so the edges meet.
          paddingLeft: "max(env(safe-area-inset-left), var(--chat-gutter))",
          paddingRight: "max(env(safe-area-inset-right), var(--chat-gutter))",
          paddingBottom: `max(env(safe-area-inset-bottom), ${isMobile ? "0.75rem" : "1.25rem"})`,
          maxWidth: `calc(${CHAT_COLUMN_MAX_PX}px + 2 * var(--chat-gutter))`,
          marginLeft: "auto",
          marginRight: "auto",
          width: "100%",
          boxSizing: "border-box"
        }}
      >
        {above && <div ref={aboveRef} data-slot="composer-above" className="flex min-h-0 flex-col">{above}</div>}
        {/* On a touch screen it steps aside while a field above it is typed
            in (useAnsweringAbove, globals.css): the keyboard can leave too
            little room for both. */}
        <div data-slot="composer-area" className="flex flex-col gap-1.5">{body}</div>
      </div>
    </div>
  );
});

function QueuedMessageLine({
  message,
  onDelete
}: {
  message: PendingMessage;
  onDelete?: (localId: string) => void;
}) {
  const attachmentCount = message.attachments?.length ?? 0;
  // An answer says what it answers after its words: they stay in sight.
  const answerTo = message.answers?.[0]?.question;
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md bg-background/70 px-2 py-1 text-xs text-foreground/90 pointer-coarse:min-h-11 pointer-coarse:py-0 pointer-coarse:pr-0">
      <div data-slot="queued-message" title={answerTo} className="min-w-0 flex-1 truncate">
        {message.content || "(image)"}
        {answerTo && <span data-slot="queued-answer-to" className="text-muted-foreground">{` · answer to “${answerTo}”`}</span>}
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:size-11"
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

function composerPlaceholder(scope: AgentChatScope | undefined): string {
  switch (scope?.type) {
    case "worker": return "Message the worker…";
    case "manager": return "Message the manager…";
    case "global": return "Ask about any thread or worker, or tell one what to do";
    default: return "Message…";
  }
}

/** The images about to be sent, each with a way to take it back. */
function AttachmentThumbnails({ attachments, onRemove }: {
  attachments: AgentMessageAttachment[];
  onRemove: (id: string) => void;
}) {
  return (
    <div className="flex max-h-28 gap-2 overflow-x-auto px-1 pb-1">
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
            // On a touch screen the button is the thumbnail's 44px corner
            // (the thumbnail clips), the dot drawn in the same place.
            className="absolute right-1 top-1 rounded-full pointer-coarse:right-0 pointer-coarse:top-0 pointer-coarse:flex pointer-coarse:size-11 pointer-coarse:items-start pointer-coarse:justify-end pointer-coarse:p-1"
            onClick={() => onRemove(attachment.id)}
          >
            <span className="block rounded-full bg-background/90 p-0.5 text-foreground shadow-sm">
              <X className="h-3 w-3" />
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
