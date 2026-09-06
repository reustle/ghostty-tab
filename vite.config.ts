import { defineConfig } from "vite";

export default defineConfig({
  build: {
    // ghostty-web 0.4 embeds its 404 KiB WASM payload in the browser bundle.
    chunkSizeWarningLimit: 700,
    outDir: "dist/client",
    emptyOutDir: false,
  },
});
