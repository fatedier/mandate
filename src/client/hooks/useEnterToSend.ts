import { useRef, type KeyboardEvent } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";

/** A composer's Enter key: it sends, Shift+Enter is a new line, and it never
 *  sends with Cmd or Ctrl held or while it confirms an IME candidate. A touch
 *  keyboard has Enter but no easy Shift+Enter, so there Enter is a new line and
 *  the send button sends; asked of the pointer, not the width, since a narrow
 *  desktop window still has a real keyboard. */
export function useEnterToSend(send: () => void) {
  const enterSends = !useMediaQuery("(pointer: coarse)");
  // Safari reports isComposing false on the Enter that confirms a candidate,
  // so composition is tracked too, and keyCode 229 checked.
  const composingRef = useRef(false);
  /** An IME candidate is being confirmed or dropped: this key (the browser's
   *  own event) is the IME's, not ours. */
  const isComposing = (e: { isComposing: boolean; keyCode: number }) =>
    composingRef.current || e.isComposing || e.keyCode === 229;
  return {
    enterSends,
    isComposing,
    textareaProps: {
      onCompositionStart: () => { composingRef.current = true; },
      // After the confirming keydown has been seen, not before it.
      onCompositionEnd: () => { window.setTimeout(() => { composingRef.current = false; }, 0); },
      onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (isComposing(e.nativeEvent) || !enterSends) return;
        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          e.preventDefault();
          send();
        }
      }
    }
  };
}
