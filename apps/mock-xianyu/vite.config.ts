import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === "production" ? "/mock/" : "/",
  server: { host: "127.0.0.1", port: 5174 }
});

