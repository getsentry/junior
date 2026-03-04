import { withJunior } from "junior/config";
import workflowNext from "workflow/next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { withWorkflow } = workflowNext;

export default withWorkflow(
  withJunior(
    {
      turbopack: {
        root: path.resolve(__dirname, "../..")
      }
    },
    {
      dataDir: "./packages/jr-sentry/data",
      skillsDir: "./packages/jr-sentry/skills",
      pluginsDir: "./packages/jr-sentry/plugins"
    }
  )
);
