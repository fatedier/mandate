/** Whether this page can show a system notification, and if not why:
 *  "default" — it could, once the browser's permission is given. */
export type PageNotifySupport = "ok" | "default" | "denied" | "insecure" | "unsupported";

type NavigatorWithUaData = Navigator & { userAgentData?: { mobile?: boolean } };

/** A phone or tablet browser. Their page notifications are out of reach:
 *  Chrome on Android shows them only from a service worker (Mandate has
 *  none), and Safari on iOS has none in a tab. An Android tablet says it is
 *  not mobile, and an iPad says it is a Mac: the platform decides first. */
export function isPhone(nav: Navigator = navigator): boolean {
  const agent = nav.userAgent;
  if (/Android|iPhone|iPad|iPod/.test(agent)) return true;
  if (/Macintosh/.test(agent) && nav.maxTouchPoints > 1) return true;
  return (nav as NavigatorWithUaData).userAgentData?.mobile === true;
}

export function deviceKind(): "desktop" | "phone" {
  return isPhone() ? "phone" : "desktop";
}

export function pageNotifySupport(): PageNotifySupport {
  if (typeof window === "undefined" || !window.isSecureContext) return "insecure";
  if (typeof window.Notification === "undefined" || isPhone()) return "unsupported";
  const permission = window.Notification.permission;
  return permission === "granted" ? "ok" : permission === "denied" ? "denied" : "default";
}
