import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    allowedHosts: true,
  },
  plugins: [nitro()],
});
