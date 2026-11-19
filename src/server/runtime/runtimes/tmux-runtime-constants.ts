export const INPUT_CHUNK_BYTES = 256;
export const DEFAULT_INITIAL_HISTORY_ROWS = 1000;
export const MIN_INITIAL_HISTORY_ROWS = 20;
export const MAX_INITIAL_HISTORY_ROWS = 5000;
export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 300;
export const MIN_TERMINAL_ROWS = 8;
export const MAX_TERMINAL_ROWS = 200;
export const INITIAL_FIT_SETTLE_FIRST_SAMPLE_MS = 100;
export const INITIAL_FIT_SETTLE_SAMPLE_MS = 80;
export const INITIAL_FIT_SETTLE_MAX_MS = 1400;
export const INITIAL_FIT_STABLE_SAMPLES = 3;
export const INITIAL_FIT_NEARLY_STABLE_AFTER_MS = 500;
export const INITIAL_FIT_NEARLY_STABLE_ROWS = 2;
export const FIT_RESTORE_GRACE_MS = 400;
/** How often windows held for viewers on Auto are checked for a terminal
 *  on them used since (TmuxFitManager.yieldToActiveClients). */
export const ACTIVE_TERMINAL_CHECK_MS = 1500;
/** A viewer given back is painted when it lets go, having taken the pane's
 *  size; this long without that (its notice lost), it is painted anyway. */
export const GIVEN_BACK_PAINT_MS = 3000;
export const TMUX_FIELD_SEP = "__MANDATE_FIELD__";

// WSContext readyState constants — Hono mirrors the standard WebSocket numeric
// constants but doesn't expose them as named exports.
export const WS_CONNECTING = 0 as const;
export const WS_OPEN = 1 as const;
