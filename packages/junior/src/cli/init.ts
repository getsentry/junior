import fs from "node:fs";
import path from "node:path";
import { juniorVercelConfig } from "../vercel";

function writeServerEntry(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "server.ts"),
    `import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";

const app = await createApp();

export default app;
`,
  );
}

function writeQueueConsumerEntry(targetDir: string): void {
  const queueConsumerDir = path.join(targetDir, "api", "internal", "agent");
  fs.mkdirSync(queueConsumerDir, { recursive: true });
  fs.writeFileSync(
    path.join(queueConsumerDir, "continue.ts"),
    `import app from "../../../server.ts";

export const POST = (request: Request) => app.fetch(request);
`,
  );
}

function writePluginsFile(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "plugins.ts"),
    `import { defineJuniorPlugins } from "@sentry/junior";
import { createMemoryPlugin } from "@sentry/junior-memory";

export const plugins = defineJuniorPlugins([
  createMemoryPlugin(),
  "@sentry/junior-maintenance",
]);
`,
  );
}

function writeNitroConfig(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "nitro.config.ts"),
    `import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorNitro({
      plugins: "./plugins",
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
`,
  );
}

function writeViteConfig(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "vite.config.ts"),
    `import { defineConfig } from "vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    allowedHosts: true,
  },
  plugins: [nitro()],
});
`,
  );
}

function writeVercelJson(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "vercel.json"),
    `${JSON.stringify(juniorVercelConfig(), null, 2)}\n`,
  );
}

function writeGitHubWorkflow(targetDir: string): void {
  const workflowDir = path.join(targetDir, ".github", "workflows");
  fs.mkdirSync(workflowDir, { recursive: true });
  fs.writeFileSync(
    path.join(workflowDir, "ci.yml"),
    `name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
        with:
          version: 10
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm check
      - run: pnpm build
`,
  );
}

export async function runInit(
  dir: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  const targetDir = dir.trim();
  if (!targetDir) {
    throw new Error("usage: junior init <dir>");
  }

  const target = path.resolve(targetDir);
  if (fs.existsSync(target)) {
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) {
      throw new Error(`refusing to initialize non-directory path: ${target}`);
    }
    if (fs.readdirSync(target).length > 0) {
      throw new Error(`refusing to initialize non-empty directory: ${target}`);
    }
  } else {
    fs.mkdirSync(target, { recursive: true });
  }

  const name = path.basename(target);
  const pkg = {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite dev",
      check: "junior check",
      build: "junior snapshot create && vite build",
    },
    dependencies: {
      "@sentry/junior": "latest",
      "@sentry/junior-memory": "latest",
      "@sentry/junior-maintenance": "latest",
      hono: "^4.12.0",
    },
    devDependencies: {
      jiti: "^2.6.1",
      nitro: "3.0.260311-beta",
      typescript: "^5.9.0",
      vite: "^8.0.3",
    },
  };
  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );

  const appDir = path.join(target, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "SOUL.md"),
    `# ${name}\n\nYou are ${name}, a helpful assistant.\n`,
  );
  fs.writeFileSync(
    path.join(appDir, "WORLD.md"),
    `# ${name} World\n\nOperational context and domain knowledge for ${name}.\n`,
  );
  fs.writeFileSync(
    path.join(appDir, "DESCRIPTION.md"),
    `${name} helps your team make progress directly in Slack.\n`,
  );

  const skillsDir = path.join(appDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, ".gitkeep"), "");

  const pluginsDir = path.join(appDir, "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, ".gitkeep"), "");

  fs.writeFileSync(
    path.join(target, ".gitignore"),
    `node_modules/
.vercel/
.output/
.nitro/
.env
.env.local
`,
  );
  fs.writeFileSync(
    path.join(target, ".env.example"),
    `SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
JUNIOR_SECRET=
JUNIOR_BOT_NAME=
JUNIOR_SLASH_COMMAND=
AI_MODEL=
AI_FAST_MODEL=
AI_VISION_MODEL=
AI_WEB_SEARCH_MODEL=
REDIS_URL=
CRON_SECRET=
SENTRY_DSN=
SENTRY_ORG_SLUG=
`,
  );

  writeServerEntry(target);
  writeQueueConsumerEntry(target);
  writePluginsFile(target);
  writeNitroConfig(target);
  writeViteConfig(target);
  writeVercelJson(target);
  writeGitHubWorkflow(target);

  log(`Created ${name} at ${target}`);
  log("");
  log(`  cd ${targetDir} && pnpm install && pnpm dev`);
  log("");
}
