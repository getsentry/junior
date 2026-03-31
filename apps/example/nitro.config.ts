import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "nitro";

export default defineConfig({
  preset: "vercel",
  vercel: {
    functions: {
      maxDuration: 800,
    },
  },
  hooks: {
    compiled() {
      cpSync(
        resolve("app"),
        resolve(".vercel/output/functions/__server.func/app"),
        { recursive: true },
      );
    },
  },
});
