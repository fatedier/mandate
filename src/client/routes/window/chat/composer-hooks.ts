import { useCallback, useEffect, useState, type RefObject } from "react";
import type { AgentMessageAttachment } from "@shared/agent-message-types";
import type { MentionPick } from "./mention-picks";

export const INPUT_MIN_HEIGHT_PX = 44;
export const INPUT_MAX_LINES = 8;

/** Unsent text and images, per conversation. Kept outside the composer:
 *  hiding the worker panel, maximizing the chat or closing the phone's sheet
 *  unmounts it, and what was typed must still be there when it comes back. */
const drafts = new Map<string, { value: string; attachments: AgentMessageAttachment[]; mentions: MentionPick[] }>();

/** A draft that was sent goes. With `sent`, only while the kept draft is
 *  still that text (a send landing after another was typed leaves the new one). */
export function forgetDraft(draftKey: string, sent?: string): void {
  if (sent === undefined || drafts.get(draftKey)?.value === sent) drafts.delete(draftKey);
}

/** The composer's text, images and the @ picks its text holds, kept as the
 *  conversation's draft. */
export function useConversationDraft(draftKey: string | null) {
  const [value, setValue] = useState(() => (draftKey ? drafts.get(draftKey)?.value : undefined) ?? "");
  const [attachments, setAttachments] = useState<AgentMessageAttachment[]>(() => (draftKey ? drafts.get(draftKey)?.attachments : undefined) ?? []);
  const [mentions, setMentions] = useState<MentionPick[]>(() => (draftKey ? drafts.get(draftKey)?.mentions : undefined) ?? []);
  // The same composer shown for another conversation: that one's draft.
  const [shownKey, setShownKey] = useState(draftKey);
  if (shownKey !== draftKey) {
    setShownKey(draftKey);
    setValue((draftKey ? drafts.get(draftKey)?.value : undefined) ?? "");
    setAttachments((draftKey ? drafts.get(draftKey)?.attachments : undefined) ?? []);
    setMentions((draftKey ? drafts.get(draftKey)?.mentions : undefined) ?? []);
  }
  useEffect(() => {
    if (!draftKey || shownKey !== draftKey) return;
    if (value || attachments.length > 0) drafts.set(draftKey, { value, attachments, mentions });
    else drafts.delete(draftKey);
  }, [draftKey, shownKey, value, attachments, mentions]);
  return { value, setValue, attachments, setAttachments, mentions, setMentions };
}

/** Fits the box to its text (the placeholder too, when empty): on typing,
 *  and when its width changes and the text wraps anew — measured only on
 *  typing, an empty box stayed a line short of a placeholder that wrapped
 *  later. Below the cap (`maxLines` of text, with the box's own padding and
 *  border) it never scrolls, so a few pixels over draw no bar. A box drawn
 *  only at times says so (`shown`): each time it is drawn it is fitted and
 *  watched anew. */
export function useAutoFitTextarea(
  taRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  { maxLines = INPUT_MAX_LINES, minHeight = INPUT_MIN_HEIGHT_PX, shown = true }: { maxLines?: number; minHeight?: number; shown?: boolean } = {}
): void {
  const fit = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    // The box drops to one line to measure its text. What holds it keeps its
    // height meanwhile: its dropping too made the transcript above taller for
    // a moment, and the browser pulled the transcript's scroll back with it,
    // so a reader at the end was taken as having scrolled up.
    const holder = ta.parentElement;
    const held = holder?.style.minHeight ?? "";
    if (holder) holder.style.minHeight = `${holder.offsetHeight}px`;
    ta.style.height = "auto";
    const style = getComputedStyle(ta);
    const px = (v: string) => parseFloat(v) || 0;
    const lineHeight = parseInt(style.lineHeight, 10) || 20;
    // scrollHeight counts the padding, not the border, which the box's height includes.
    const maxHeight = lineHeight * maxLines + px(style.paddingTop) + px(style.paddingBottom);
    const border = px(style.borderTopWidth) + px(style.borderBottomWidth);
    ta.style.height = `${Math.max(minHeight, Math.min(ta.scrollHeight, maxHeight) + border)}px`;
    ta.style.overflowY = ta.scrollHeight > maxHeight ? "auto" : "hidden";
    if (holder) holder.style.minHeight = held;
  }, [taRef, maxLines, minHeight]);
  useEffect(() => { fit(); }, [value, fit, shown]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta || typeof ResizeObserver === "undefined") return;
    // Its own height changes as it fits: only a new width means re-wrapped text.
    let width = ta.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (ta.offsetWidth === width) return;
      width = ta.offsetWidth;
      fit();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [fit, taRef, shown]);
}
