import { createContext } from "react";

/** False inside a page kept mounted while another shows (shell/KeptPage):
 *  what it would put in the shell's shared places, the header's title and
 *  actions, is left out until it shows again. */
export const PageShownContext = createContext(true);
