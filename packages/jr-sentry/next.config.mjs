import { withJunior } from "junior/config";
import workflowNext from "workflow/next";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { withWorkflow } = workflowNext;
const soulPath = path.resolve(__dirname, "data", "SOUL.md");
const soul = fs.readFileSync(soulPath, "utf8").trim();

if (soul.length === 0) {
  throw new Error(`SOUL.md is empty: ${soulPath}`);
}

export default withWorkflow(
  withJunior(
    {
      env: {
        JUNIOR_SOUL: soul
      },
      outputFileTracingIncludes: {
        "/api/**": [
          "./packages/jr-sentry/data/**/*",
          "./packages/jr-sentry/skills/**/*",
          "./packages/jr-sentry/plugins/**/*"
        ],
        "/.well-known/**": [
          "./packages/jr-sentry/data/**/*",
          "./packages/jr-sentry/skills/**/*",
          "./packages/jr-sentry/plugins/**/*"
        ]
      }
    },
    {
      dataDir: "./packages/jr-sentry/data",
      skillsDir: "./packages/jr-sentry/skills",
      pluginsDir: "./packages/jr-sentry/plugins"
    }
  )
);
