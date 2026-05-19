import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Compute a short content hash of the WASM at build time. The build pipeline
// runs `build:bysykkel:wasm` (which writes the .wasm into app/bysykkel/public/)
// before this Vite build, so the file exists. We expose the hash via `define`
// so App.tsx can append it as ?v=<hash> to the WASM fetch URL — guaranteeing
// the browser refetches whenever the C source changes. The WASM filename
// itself stays stable (bysykkel_score.wasm) so deep links / dev tools stay
// readable; only the cache key moves.
function readWasmHash(): string {
  const wasmPath = resolve(__dirname, "public/bysykkel_score.wasm");
  try {
    const bytes = readFileSync(wasmPath);
    return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  } catch {
    // No WASM yet (e.g. running `vite` before `build:bysykkel:wasm`). Falling
    // back to a timestamp ensures the placeholder is unique-per-build but
    // surfaces the missing file as a runtime fetch failure rather than a
    // silent stale-bytes situation.
    return `dev-${Date.now().toString(36)}`;
  }
}

export default defineConfig({
  base: "/bysykkel/",
  root: "app/bysykkel",
  define: {
    __BYSYKKEL_WASM_HASH__: JSON.stringify(readWasmHash()),
  },
  plugins: [react()],
  build: {
    outDir: "../../public/bysykkel",
    emptyOutDir: true,
  },
});
