import fs from "node:fs";
import path from "node:path";
import { juniorVercelConfig } from "@/vercel";

function writeServerEntry(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "server.ts"),
    `import "hono";
import { initSentry } from "@sentry/junior/instrumentation";
initSentry();

import { createApp } from "@sentry/junior";

const app = await createApp();

export default app;
`,
  );
}

function writeVercelJson(targetDir: string): void {
  const config = juniorVercelConfig();
  fs.writeFileSync(
    path.join(targetDir, "vercel.json"),
    `${JSON.stringify(config, null, 2)}\n`,
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
      build: "junior snapshot create",
    },
    dependencies: {
      "@sentry/junior": "latest",
      "@sentry/node": "^10.0.0",
      hono: "^4.12.0",
    },
    devDependencies: {
      typescript: "^5.9.0",
      vercel: "^50.37.0",
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
    path.join(appDir, "ABOUT.md"),
    `# About ${name}\n\nDescribe what ${name} helps users do.\n`,
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
.env
.env.local
`,
  );
  fs.writeFileSync(
    path.join(target, ".env.example"),
    `SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=
JUNIOR_BOT_NAME=
AI_MODEL=
AI_FAST_MODEL=
REDIS_URL=
SENTRY_DSN=
`,
  );

  writeServerEntry(target);
  writeVercelJson(target);

  log(`Created ${name} at ${target}`);
  log("");
  log(`  cd ${targetDir} && pnpm install && vercel dev`);
  log("");
}
