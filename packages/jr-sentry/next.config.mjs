import { withJunior } from "junior/config";
import workflowNext from "workflow/next";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { withWorkflow } = workflowNext;
const RUNTIME_ASSETS_DIR = "runtime-assets";
const ASSET_DIRS = ["data", "skills", "plugins"];

class CopyRuntimeAssetsPlugin {
  apply(compiler) {
    compiler.hooks.afterEmit.tap("CopyRuntimeAssetsPlugin", () => {
      const outputPath = compiler.options.output.path;
      if (!outputPath) {
        return;
      }

      const runtimeAssetsRoot = path.join(outputPath, RUNTIME_ASSETS_DIR);
      fs.mkdirSync(runtimeAssetsRoot, { recursive: true });

      for (const dirName of ASSET_DIRS) {
        const sourceDir = path.join(__dirname, dirName);
        if (!fs.existsSync(sourceDir)) {
          continue;
        }
        const destinationDir = path.join(runtimeAssetsRoot, dirName);
        fs.cpSync(sourceDir, destinationDir, { recursive: true, force: true });
      }
    });
  }
}

export default withWorkflow(
  withJunior(
    {
      webpack(config, { isServer }) {
        if (isServer) {
          config.plugins.push(new CopyRuntimeAssetsPlugin());
        }
        return config;
      },
      outputFileTracingRoot: path.resolve(__dirname, "../.."),
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
