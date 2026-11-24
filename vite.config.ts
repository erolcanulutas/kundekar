import { defineConfig } from "vite";

// Served from https://erolcanulutas.github.io/kundekar/
export default defineConfig({
  base: "/kundekar/",
  worker: { format: "es" },
});
