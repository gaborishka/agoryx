import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * @pierre/diffs draws its few words of UI (between hunks, at a file's end) inside its shadow DOM, in
 * English and without options; the page says them in Ukrainian. A string it no longer has fails the build.
 */
const PIERRE_UK: Array<[RegExp, string, string]> = [
  [
    /renderers\/DiffHunksRenderer\.js$/,
    'return `${lines} unmodified line${EN_PLURAL_RULES.select(lines) === "one" ? "" : "s"}`;',
    'const n = lines % 100, d = lines % 10; return `${lines} ${d === 1 && n !== 11 ? "рядок" : d >= 2 && d <= 4 && (n < 12 || n > 14) ? "рядки" : "рядків"} без змін`;',
  ],
  [/utils\/createSeparator\.js$/, 'createTextNodeElement("Expand all")', 'createTextNodeElement("Розгорнути все")'],
  [/utils\/createNoNewlineElement\.js$/, 'createTextNodeElement("No newline at end of file")', 'createTextNodeElement("Без нового рядка в кінці файлу")'],
];
const pierreUk = (): Plugin & { transform: (code: string, id: string) => string | null } => ({
  name: "agoryx:pierre-uk",
  enforce: "pre",
  transform(code: string, id: string) {
    if (!id.includes("@pierre/diffs")) return null;
    const path = id.split("?")[0]!;
    for (const [file, from, to] of PIERRE_UK) {
      if (!file.test(path)) continue;
      if (!code.includes(from)) throw new Error(`pierre-uk: "${from.slice(0, 40)}…" is gone from ${path}; update vite.config.ts`);
      return code.replace(from, to);
    }
    return null;
  },
});

// The daemon serves the built page (ui/dist); `npm run dev` proxies the API to a running daemon.
export default defineConfig({
  plugins: [pierreUk(), react(), tailwindcss()],
  // The dev server pre-bundles dependencies, past the plugins above.
  optimizeDeps: { rolldownOptions: { plugins: [pierreUk()] } },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@agora": fileURLToPath(new URL("../internal/agora", import.meta.url)),
    },
  },
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: {
    // AGORYX_UI_DAEMON: another daemon (a demo one on its own AGORYX_HOME and port).
    proxy: {
      "/api": { target: process.env.AGORYX_UI_DAEMON ?? "http://127.0.0.1:7717", changeOrigin: false, ws: true },
      "/raw": { target: process.env.AGORYX_UI_DAEMON ?? "http://127.0.0.1:7717", changeOrigin: false },
    },
  },
});
