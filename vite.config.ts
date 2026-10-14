import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: { "/api": `http://127.0.0.1:${process.env.API_PORT ?? 4317}`, "/files": `http://127.0.0.1:${process.env.API_PORT ?? 4317}` }
  },
  build: { outDir: "dist" }
});
