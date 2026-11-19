import { createContext } from "react";

/** Whether the canvas around is the one shown: a panel keeps a canvas tab
 *  drawn while another tab shows, and a hidden one must leave the keys to
 *  what is shown. Shown unless a panel says otherwise. */
export const CanvasShownContext = createContext(true);
