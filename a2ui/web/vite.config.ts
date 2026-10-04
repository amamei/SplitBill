import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.PORT || "8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // SSE (/api/events) streams through http-proxy unbuffered; no websocket upgrade needed.
      "/api": { target: `http://localhost:${apiPort}`, changeOrigin: true, ws: false },
    },
  },
});
