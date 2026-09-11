import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 4316,
    // The concept iframe loads /api/runs/:id/concept through this proxy, so it is
    // same-origin with the app in dev. The overlay does not depend on that — it is
    // driven by postMessage — which is what lets a hosted runner serve it elsewhere.
    proxy: { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } },
  },
});
