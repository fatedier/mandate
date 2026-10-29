// Shared by terminal-scroll-routes and terminal-scroll-travel.

/** What the stand-in terminal server sends first: 300 lines of history, and
 *  then the screen a test needs. */
const HISTORY = Array.from({ length: 300 }, (_, i) => `line-${String(i + 1).padStart(3, "0")}`).join("\r\n");
export const SCREENS = {
  normal: HISTORY,
  alternate: `${HISTORY}\r\n\x1b[?1049h\x1b[2J\x1b[HFULL SCREEN VIEW`,
  mouse: `${HISTORY}\r\n\x1b[?1049h\x1b[2J\x1b[HFULL SCREEN VIEW\x1b[?1000h\x1b[?1006h`,
  // X10 reports presses only, never the wheel: as if no mouse was asked for.
  x10: `${HISTORY}\r\n\x1b[?1049h\x1b[2J\x1b[HFULL SCREEN VIEW\x1b[?9h`
} as const;

/** Each input by what it is, so a count that depends on pixels is not pinned. */
export function kinds(inputs: string[]): string[] {
  const named = inputs.map((data) =>
    /^\x1b[[O]A$/.test(data) ? "up-arrow"
      : /^\x1b\[<64;\d+;\d+M$/.test(data) ? "wheel-up"
        : `other:${JSON.stringify(data)}`
  );
  return [...new Set(named)];
}
