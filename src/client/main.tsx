import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { applyShellFlag } from "./lib/runtime";
import { installTauriDragRegionIfDesktop } from "./shell/tauri-drag-region";
import { trackDesktopFullscreenIfDesktop } from "./shell/desktop-fullscreen";
import { installDesktopZoomIfDesktop } from "./shell/desktop-zoom-wiring";
import { trackBackendStatusIfDesktop } from "./shell/backend-status";

applyShellFlag();
installTauriDragRegionIfDesktop();
trackDesktopFullscreenIfDesktop();
installDesktopZoomIfDesktop();
trackBackendStatusIfDesktop();

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
