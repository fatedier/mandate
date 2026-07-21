/** Copy text to the clipboard. The async clipboard API only works in secure
 *  contexts — localhost or HTTPS. Anything else (plain-HTTP LAN addresses,
 *  tunnels like FRP) throws "permission denied" or isn't defined, so this
 *  falls back to a hidden textarea + the browser copy command. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the insecure-context fallback */
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}
