import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the web player page for the showcase site. Relative asset paths, so it
// works from whatever folder the site is served under.
export default defineConfig({
  root: "player",
  base: "./",
  plugins: [react(), tailwindcss()],
  // The scenes import the app's components from ../src, whose own imports of
  // React would otherwise resolve to a second copy in the app's node_modules.
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "../dist", emptyOutDir: true },
});
