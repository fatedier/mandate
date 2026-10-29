/** Copy text to the clipboard. The async clipboard API only works in secure
 *  contexts — localhost or HTTPS. Anything else (a plain-HTTP origin)
 *  throws "permission denied" or isn't defined, so this
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
  // Inside a modal dialog the textarea goes in the dialog: it keeps focus
  // within itself and would take it back from one outside before the copy.
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = previous?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body;
  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    host.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previous?.focus({ preventScroll: true });
  }
}
