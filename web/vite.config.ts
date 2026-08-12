import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{html,js,css,json,png,svg,woff2}"],
        globIgnores: [
          "**/*.mp4",
          "**/*.webm",
          "**/*.m3u8",
          "brand/**",
          "favicon-16-20260812b.png",
          "icons/*-source.svg"
        ],
        minify: false,
        rollupFormat: "iife",
        sourcemap: false
      }
    })
  ],
  // The InstaPods deploy runs `cd web && vite build`, so Vite's root is `web/`
  // and it would only read `web/.env*`. InstaPods writes its environment
  // variables to `.env` at the pod root, one level up. Point envDir there so
  // dashboard-configured VITE_* values actually reach the build.
  // Variables exported into the build process are still picked up as usual.
  envDir: "..",
  build: {
    target: "es2022"
  }
});
