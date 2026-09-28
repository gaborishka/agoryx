import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The daemon serves the built page (ui/dist); `npm run dev` proxies the API to a running daemon.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@agora": fileURLToPath(new URL("../internal/agora", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:7717", changeOrigin: false },
      "/raw": { target: "http://127.0.0.1:7717", changeOrigin: false },
    },
  },
});
