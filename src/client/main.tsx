import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { installTauriDragRegionIfDesktop } from "./shell/tauri-drag-region";
import { trackDesktopFullscreenIfDesktop } from "./shell/desktop-fullscreen";
import { installDesktopZoomIfDesktop } from "./shell/desktop-zoom-wiring";
import { installDesktopReopenTabIfDesktop } from "./shell/desktop-reopen-tab-wiring";
import { trackBackendStatusIfDesktop } from "./shell/backend-status";

installTauriDragRegionIfDesktop();
trackDesktopFullscreenIfDesktop();
installDesktopZoomIfDesktop();
installDesktopReopenTabIfDesktop();
trackBackendStatusIfDesktop();

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
