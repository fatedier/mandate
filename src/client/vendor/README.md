# Canvas Tailwind runtime

This classic browser script is pinned to Tailwind CSS 3.4.17, the version
previously served to Canvas by `https://cdn.tailwindcss.com`. It is a URL
asset, separate from the app bundle and from the main UI's Tailwind version.
Vite fingerprints it; the binary build embeds it and the HTTP server
compresses and caches it with the other static assets. Normal builds and
default Canvas rendering do not fetch Tailwind from the CDN.

The file contains the unmodified upstream full build (512539 bytes) with its
Tailwind license appended so binary distributions retain the license. All
official CDN plugins are enabled: forms, typography, aspect-ratio, line-clamp
and container-queries. Canvas documents share this one asset regardless of
their original `plugins` parameter. Their custom config and CSS still apply.

`bun scripts/vendor-canvas-tailwind.ts` reproduces the file. It verifies the
upstream SHA-256 hash before appending the license. Updating the version
requires reviewing the hash and Canvas browser tests.
Upstream bundled notices are retained; see `LICENSE.tailwindcss` for the
Tailwind Labs MIT license. The source URL and hash are in the maintenance script.
