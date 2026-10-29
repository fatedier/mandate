import type { SetupStatusResponse } from "@shared/api-contracts";

const SETUP_SESSION_STORAGE_KEY = "mandate.setup.active";

export function readSetupSessionActive(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(SETUP_SESSION_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function writeSetupSessionActive(active: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (active) {
      window.sessionStorage.setItem(SETUP_SESSION_STORAGE_KEY, "true");
    } else {
      window.sessionStorage.removeItem(SETUP_SESSION_STORAGE_KEY);
    }
  } catch {
    // Some embedded browsers can deny sessionStorage. In-memory state still keeps setup visible.
  }
}

export function shouldResumePartialSetup(status: SetupStatusResponse, hasProjects: boolean): boolean {
  return !hasProjects && status.models.providerCount > 0 && !status.models.ready;
}
