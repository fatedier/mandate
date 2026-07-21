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
export const FIT_RESTORE_GRACE_MS = 400;
export const TMUX_FIELD_SEP = "__MANDATE_FIELD__";

// WSContext readyState constants — Hono mirrors the standard WebSocket numeric
// constants but doesn't expose them as named exports.
export const WS_CONNECTING = 0 as const;
export const WS_OPEN = 1 as const;
