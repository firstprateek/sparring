import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * The build's id, so an open page can tell that the daemon now serves a newer one (src/update.ts). It is a hash
 * of every file the build writes, taken before this plugin adds anything: the same source builds the same id,
 * and a rebuild that changes nothing asks no one to reload. Each page carries it in
 * `<meta name="sparring-build">`; `build.json` holds the one being served.
 */
function buildId(): Plugin {
  return {
    name: "sparring-build-id",
    enforce: "post",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        const hash = createHash("sha256");
        for (const name of Object.keys(bundle).sort()) {
          const item = bundle[name];
          if (!item) continue;
          hash.update(`${name}\0`);
          hash.update(item.type === "chunk" ? item.code : item.source);
          hash.update("\0");
        }
        const id = hash.digest("hex").slice(0, 16);
        for (const item of Object.values(bundle)) {
          if (item.type === "asset" && item.fileName.endsWith(".html") && typeof item.source === "string") {
            item.source = item.source.replace(
              "<head>",
              `<head>\n<meta name="sparring-build" content="${id}">`,
            );
          }
        }
        this.emitFile({
          type: "asset",
          fileName: "build.json",
          source: `${JSON.stringify({ build: id })}\n`,
        });
      },
    },
  };
}

export default defineConfig({
  plugins: [buildId()],
  build: {
    // Fonts and images stay files: the CSP allows fonts from this origin only, never data: URIs.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        room: resolve(import.meta.dirname, "room.html"),
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:7421", "/ahp": { target: "ws://127.0.0.1:7421", ws: true } } },
});
