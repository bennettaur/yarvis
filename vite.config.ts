import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Dev-server port. Fixed at 1420 for the usual single-instance run; a second
// Yarvis instance running alongside it needs its own (see
// `scripts/dev-instance.ts`, which sets this and the matching `devUrl`).
// @ts-expect-error process is a nodejs global
const port = Number(process.env.YARVIS_DEV_PORT) || 1420;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port,
    strictPort: true,
    host: host || false,
    // The port above the dev server's. `scripts/dev-instance.ts` allocates
    // instance ports in pairs so this one is never another instance's server.
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri` and git directories
      ignored: ["**/src-tauri/**", "**/.git/**", "**/.worktrees/**"],
    },
  },
}));
