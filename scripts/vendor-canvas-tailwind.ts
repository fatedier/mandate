// Explicit maintenance command only. Normal builds never fetch the CDN.
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";

const vendorDir = new URL("../src/client/vendor/", import.meta.url);
await mkdir(vendorDir, { recursive: true });
const license = await Bun.file(new URL("LICENSE.tailwindcss", vendorDir)).text();
const url = "https://cdn.tailwindcss.com/3.4.17?plugins=forms,typography,aspect-ratio,line-clamp,container-queries";
const sha256 = "36ffe18a4dab810e068761c88bb6a4e222b94f2aec4270c5666e47f4a73f36f8";
const response = await fetch(url);
if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
const content = await response.text();
if (createHash("sha256").update(content).digest("hex") !== sha256) {
  throw new Error(`Upstream asset changed: ${url}`);
}
await Bun.write(new URL("tailwind-3.4.17.js", vendorDir), `${content}\n/*!\n${license}*/\n`);
