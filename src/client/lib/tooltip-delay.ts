/** A tooltip is a pause, not a pop: it appears after the pointer has rested
 *  on a control, like the system's, so brushing past the collapsed rail does
 *  not fire a label per icon. Once one tooltip is up, neighbouring ones open
 *  without the wait (Radix's skip delay), so scanning down the rail stays
 *  quick. 0 (the old default) made every tooltip instant. */
export const TOOLTIP_DELAY_MS = 600;
export const TOOLTIP_SKIP_DELAY_MS = 300;
