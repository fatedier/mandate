type TerminalFrame = string | Blob | ArrayBuffer | ArrayBufferView;

/**
 * One socket's incoming frames, decoded and handed to the terminal in order.
 *
 * The server opens every connection with an authoritative capture of the
 * pane (history included, sent as a text frame) and then streams live bytes
 * (binary frames). A socket that replaces an earlier one therefore passes
 * `resetFirst`: the terminal is reset right before the first capture, so it
 * replaces what the old connection drew instead of repeating below it, and
 * the old screen stays up until then. Only a capture triggers the reset:
 * when the server could not take one it sends live bytes straight away, and
 * clearing the old screen for those would leave a fragment.
 *
 * Resetting also returns input modes (mouse reporting, bracketed paste) to
 * their defaults — exactly the state a freshly opened terminal starts from,
 * since the capture does not carry them either.
 */
export function createTerminalFrameWriter(options: {
  write: (text: string) => Promise<void>;
  reset: () => void;
  resetFirst: boolean;
  /** Called for every frame that carried text. */
  onFrame?: () => void;
}): (frame: TerminalFrame) => Promise<void> {
  let decoder = new TextDecoder();
  let pendingReset = options.resetFirst;
  return async (frame) => {
    let text: string;
    if (typeof frame === "string") {
      // Text frames are authoritative snapshots/control responses rather
      // than a continuation of the binary pipe stream.
      decoder = new TextDecoder();
      text = frame;
    } else if (frame instanceof Blob) {
      text = decoder.decode(new Uint8Array(await frame.arrayBuffer()), { stream: true });
    } else {
      text = decoder.decode(frame, { stream: true });
    }
    if (!text) return;
    if (pendingReset && typeof frame === "string") {
      pendingReset = false;
      options.reset();
    }
    options.onFrame?.();
    await options.write(text);
  };
}
