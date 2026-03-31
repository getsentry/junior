import fs from "node:fs";
import path from "node:path";

function writeServerEntry(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "server.ts"),
    [
      'import { initSentry } from "@sentry/junior/instrumentation";',
      "initSentry();",
      "",
      'import { createApp } from "@sentry/junior";',
      "",
      "const app = await createApp();",
      "",
      "export default app;",
      "",
    ].join("\n"),
  );
}

function writeNitroConfig(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "nitro.config.ts"),
    [
      'import { cpSync } from "node:fs";',
      'import { resolve } from "node:path";',
      'import { defineConfig } from "nitro";',
      "",
      "export default defineConfig({",
      '  preset: "vercel",',
      "  vercel: {",
      "    functions: {",
      "      maxDuration: 800,",
      "    },",
      "  },",
      "  hooks: {",
      "    compiled() {",
      "      cpSync(",
      '        resolve("app"),',
      '        resolve(".vercel/output/functions/__server.func/app"),',
      "        { recursive: true },",
      "      );",
      "    },",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
}

function writeViteConfig(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "vite.config.ts"),
    [
      'import { defineConfig } from "vite";',
      'import { nitro } from "nitro/vite";',
      "",
      "export default defineConfig({",
      "  plugins: [nitro()],",
      "});",
      "",
    ].join("\n"),
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
      build: "junior snapshot create && vite build",
    },
    dependencies: {
      "@sentry/junior": "latest",
      "@sentry/node": "^10.0.0",
      hono: "^4.12.0",
    },
    devDependencies: {
      nitro: "3.0.260311-beta",
      typescript: "^5.9.0",
      vite: "^8.0.0",
    },
  };
  fs.writeFileSync(
    path.join(target, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );

  const dataDir = path.join(target, "app", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "SOUL.md"),
    `# ${name}\n\nYou are ${name}, a helpful assistant.\n`,
  );
  fs.writeFileSync(
    path.join(dataDir, "ABOUT.md"),
    `# About ${name}\n\nDescribe what ${name} helps users do.\n`,
  );

  const skillsDir = path.join(target, "app", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, ".gitkeep"), "");

  const pluginsDir = path.join(target, "app", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, ".gitkeep"), "");

  fs.writeFileSync(
    path.join(target, ".gitignore"),
    [
      "node_modules/",
      ".vercel/",
      ".output/",
      ".nitro/",
      ".env",
      ".env.local",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(target, ".env.example"),
    [
      "SLACK_BOT_TOKEN=",
      "SLACK_SIGNING_SECRET=",
      "JUNIOR_BOT_NAME=",
      "AI_MODEL=",
      "AI_FAST_MODEL=",
      "REDIS_URL=",
      "SENTRY_DSN=",
      "",
    ].join("\n"),
  );

  writeServerEntry(target);
  writeNitroConfig(target);
  writeViteConfig(target);

  log(`Created ${name} at ${target}`);
  log("");
  log(`  cd ${targetDir} && pnpm install && pnpm dev`);
  log("");
}
