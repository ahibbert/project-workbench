import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const packageMetadata = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
);
const buildId = process.env.PANEL_PILOT_BUILD_ID || "local";

export default defineConfig({
  base: "/",
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version),
    __BUILD_ID__: JSON.stringify(buildId),
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8013",
      "/login": "http://127.0.0.1:8013",
      "/logout": "http://127.0.0.1:8013",
    },
  },
  build: {
    target: "safari16.4",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL("./index.html", import.meta.url)),
        login: fileURLToPath(new URL("./login.html", import.meta.url)),
        "panel-test": fileURLToPath(new URL("./panel-test.html", import.meta.url)),
      },
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
        manualChunks(id) {
          if (id.includes("node_modules/epubjs") || id.includes("node_modules/jszip") || id.includes("node_modules/@xmldom")) {
            return "epub-reader-engine";
          }
        },
      },
    },
  },
  plugins: [
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.js",
      injectRegister: null,
      registerType: "prompt",
      includeManifestIcons: false,
      manifest: {
        name: "Panels",
        short_name: "Panels",
        description:
          "A mobile-first Suwayomi manga reader with guided panel navigation, discovery, and reading progress sync.",
        id: "/",
        scope: "/",
        start_url: "/#library",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        icons: [
          {
            src: "/assets/icon-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/assets/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/assets/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,png}"],
        globIgnores: [
          "login.html",
          "panel-test.html",
          "assets/panel-test-*.js",
          // Source comparison always needs live Suwayomi access. The clarity
          // worker is an optional enhancement with a native-render fallback.
          "assets/source-quality-comparison-*.*",
          "assets/reader-clarity-worker-*.js",
          "assets/books-app-*.*",
          "assets/books-*.*",
          "assets/epub-reader-*.*",
          // Stale-client checks are online-only and must never rely on the shell
          // cache they are responsible for repairing.
          "assets/app-lifecycle-*.*",
        ],
      },
    }),
  ],
});
