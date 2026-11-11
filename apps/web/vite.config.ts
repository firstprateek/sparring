import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    rollupOptions: {
      input: { index: resolve(import.meta.dirname, "index.html"), room: resolve(import.meta.dirname, "room.html") },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:7421", "/ahp": { target: "ws://127.0.0.1:7421", ws: true } } },
});
