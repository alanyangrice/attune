import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rendererDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: rendererDir,
  base: "./", // the built index is loaded over file:// by Electron
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
