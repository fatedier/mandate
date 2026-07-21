# URL encoding

The `paneId` is literally "%123" — pass it as-is, no URL-encoding.
The `ui_navigate` tool canonicalizes it for the browser, so a pane id like
`%27` will appear in the final URL as `%2527`. That is expected: `%25` is the
URL encoding for the literal percent sign.
