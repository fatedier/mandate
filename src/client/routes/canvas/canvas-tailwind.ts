// Vite fingerprints this URL asset and the binary build embeds it with the
// other static files. The runtime stays separate from the app's JS bundle.
const runtimeUrl = new URL("../../vendor/tailwind-3.4.17.js", import.meta.url).href;

export function canvasTailwindUrl(source?: string): string | null {
  if (!source) return runtimeUrl;
  let url: URL;
  try { url = new URL(source, "https://mandate.invalid"); }
  catch { return null; }
  if (!/^https?:$/.test(url.protocol) || url.hostname !== "cdn.tailwindcss.com") return null;
  // Keep references to other runtimes intact. Supported v3 references are
  // pinned to the version shipped with Mandate instead of following redirects.
  if (!/^\/(?:3(?:\.\d+){0,2})?\/?$/.test(url.pathname)) return null;
  // The full runtime includes every official CDN plugin, so all plugin
  // selections (including version-qualified redirects) share this asset.
  return runtimeUrl;
}

/** Parse only a detached script tag. Its contents never execute, and the
 * browser handles quoted/unquoted attributes and character references. */
export function localizeCanvasTailwindScript(openingTag: string): { tag: string; hasTailwind: boolean } {
  const template = document.createElement("template");
  template.innerHTML = `${openingTag}</script>`;
  const script = template.content.firstElementChild;
  const source = script?.getAttribute("src");
  if (!script || !source) return { tag: openingTag, hasTailwind: false };
  let url: URL;
  // Protocol-relative CDN tags must not inherit the desktop's tauri: scheme.
  // Relative scripts resolve to a non-CDN host here and are left untouched.
  try { url = new URL(source, "https://mandate.invalid"); }
  catch { return { tag: openingTag, hasTailwind: false }; }
  const hasTailwind = url.hostname === "cdn.tailwindcss.com";
  if (!hasTailwind) return { tag: openingTag, hasTailwind: false };
  const localUrl = canvasTailwindUrl(url.href);
  if (!localUrl) return { tag: openingTag, hasTailwind };
  script.setAttribute("src", localUrl);
  // The replacement is our pinned asset with its license notice. CDN
  // integrity hashes differ, and crossorigin would require CORS from the opaque
  // sandbox origin. Classic scripts can load the local asset without it.
  script.removeAttribute("integrity");
  script.removeAttribute("crossorigin");
  if (script.getAttribute("type")?.trim().toLowerCase() === "module") {
    // This runtime is a classic IIFE even when the author marks it as a
    // module. Keep deferred execution order without requiring module CORS.
    script.removeAttribute("type");
    script.removeAttribute("nomodule");
    script.setAttribute("defer", "");
  }
  return { tag: script.outerHTML.slice(0, -"</script>".length), hasTailwind };
}
