import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiPort = Number(process.env.MANDATE_API_PORT || 4174);
const allowedHosts = (process.env.MANDATE_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  root: "src/client",
  publicDir: path.resolve(__dirname, "assets"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src/client"),
      "@shared": path.resolve(__dirname, "src/shared")
    }
  },
  server: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    allowedHosts,
    proxy: {
      // Single target — Hono + Bun.serve handles HTTP, SSE (/api/events) and
      // WebSocket (/api/terminal) on this port.
      "/api": {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Split the dependencies that change on a different cadence than app
        // code, so a deploy doesn't invalidate React and Radix along with it.
        // Routes are already split by React.lazy in App.tsx; this only groups
        // what remains in the entry chunk.
        //
        // Function form, not the object form: Vite 8 bundles with rolldown,
        // which only accepts a function here.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return;
          if (/node_modules\/(react|react-dom|react-router|scheduler)\//.test(id)) {
            return "vendor-react";
          }
          // Markdown is deliberately NOT grouped here. Naming a manual chunk
          // pins it into the initial graph even when every importer is a
          // dynamic one — the entry HTML preloaded it despite both call sites
          // being lazy. Left alone, rolldown places the pipeline in the
          // lazily-fetched chunk its real importers live in.
          if (/node_modules\/(radix-ui|@radix-ui|sonner|lucide-react)\//.test(id)) {
            return "vendor-ui";
          }
          return;
        }
      }
    }
  }
});
