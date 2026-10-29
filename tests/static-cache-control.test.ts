import { describe, expect, test } from "bun:test";
import { staticCacheControl } from "../src/server/app/http-app.js";

describe("staticCacheControl", () => {
  test("content-hashed vite assets cache forever", () => {
    expect(staticCacheControl("/assets/index-BQLQxfuK.js")).toBe(
      "public, max-age=31536000, immutable"
    );
    expect(staticCacheControl("/assets/inter-latin-wght-normal-C9bo.woff2")).toBe(
      "public, max-age=31536000, immutable"
    );
  });

  test("unhashed entry points and brand assets revalidate", () => {
    expect(staticCacheControl("/")).toBe("no-cache");
    expect(staticCacheControl("/index.html")).toBe("no-cache");
    expect(staticCacheControl("/brand/logo.svg")).toBe("no-cache");
    expect(staticCacheControl("/projects")).toBe("no-cache"); // SPA route → index.html
  });
});
