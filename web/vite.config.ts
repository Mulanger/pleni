import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
