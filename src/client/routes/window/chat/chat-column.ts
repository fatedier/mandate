/** The chat's reading column. The transcript and the composer both take it
 *  inside the same gutters (1rem on a phone, 1.75rem from 768px), so their
 *  edges line up at every width: a bubble never runs past the composer
 *  below it. The chat owns those gutters: a padded container around it
 *  cancels its own padding (WorkerView, ArchivedWorkerView). */
export const CHAT_COLUMN_MAX_PX = 880;

/** Sets `--chat-gutter` on the transcript's scroller and the composer's box
 *  by one `md:` query. A JS media query in px (useIsMobile) and Tailwind's
 *  rem breakpoint part ways when the browser's default font size is not
 *  16px, which once put the two gutters 15px apart at 768-959px. */
export const CHAT_GUTTER_CLASS = "[--chat-gutter:1rem] md:[--chat-gutter:1.75rem]";
