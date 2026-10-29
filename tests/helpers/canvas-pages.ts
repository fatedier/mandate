/** A report that follows the page contract: no checks fire on it. */
export const CLEAN_REPORT = `<title>Cache policy</title>
<link rel="preconnect" href="https://example.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC&display=swap">
<style>
@import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono&display=swap");
:root { --page: #fbfbf9; --ink: #1f1b16; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --page: #161512; --ink: #ece6dc; color-scheme: dark; } }
:root[data-theme="dark"] { --page: #161512; --ink: #ece6dc; color-scheme: dark; }
body { background: var(--page); color: var(--ink); padding-inline: 16px; }
@font-face { font-family: Local; src: url(data:font/woff2;base64,AAAA); }
.hero { background-image: url(data:image/png;base64,AAAA); }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<main><h1>Shorten the keys</h1><img src="chart.png" alt="Chart"><a href="https://github.com/acmecorp/project-1">project-1</a></main>`;

/** The same page as an artboard draws it: no title, one look (no theme rules). */
export const CLEAN_ARTBOARD = CLEAN_REPORT
  .replace("<title>Cache policy</title>\n", "")
  .replace(/@media \(prefers-color-scheme: dark\).*\n/, "")
  .replace(/:root\[data-theme="dark"\].*\n/, "");
