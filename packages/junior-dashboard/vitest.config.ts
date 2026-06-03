import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@sentry\/junior$/,
        replacement: path.resolve(import.meta.dirname, "../junior/src/app.ts"),
      },
      {
        find: /^@sentry\/junior\/reporting$/,
        replacement: path.resolve(
          import.meta.dirname,
          "../junior/src/reporting.ts",
        ),
      },
      {
        find: /^@\//,
        replacement: `${path.resolve(import.meta.dirname, "../junior/src")}/`,
      },
    ],
  },
});
