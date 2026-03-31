import fs from "node:fs";
import path from "node:path";

function writeEntryPoint(targetDir: string): void {
  const apiDir = path.join(targetDir, "api");
  fs.mkdirSync(apiDir, { recursive: true });
  fs.writeFileSync(
    path.join(apiDir, "index.ts"),
    [
      'import { initSentry } from "@sentry/junior/instrumentation";',
      "initSentry();",
      "",
      'import { createApp } from "@sentry/junior";',
      'import { handle } from "hono/vercel";',
      "",
      "const app = await createApp();",
      "",
      "export default handle(app);",
      "",
    ].join("\n"),
  );
}

function writeDevEntry(targetDir: string): void {
  fs.writeFileSync(
    path.join(targetDir, "dev.ts"),
    [
      'import { initSentry } from "@sentry/junior/instrumentation";',
      "initSentry();",
      "",
      'import { serve } from "@hono/node-server";',
      'import { createApp } from "@sentry/junior";',
      "",
      "const app = await createApp();",
      "",
      "serve({ fetch: app.fetch, port: 3000 }, (info) => {",
      "  console.log(`Listening on http://localhost:${info.port}`);",
      "});",
      "",
    ].join("\n"),
  );
}

function writeVercelJson(targetDir: string): void {
  const config = {
    functions: {
      "api/index.ts": {
        maxDuration: 800,
        includeFiles: ["app/**/*"],
      },
    },
    rewrites: [{ source: "/api/(.*)", destination: "/api" }],
  };
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
      dev: "tsx watch dev.ts",
      build: "junior snapshot create",
    },
    dependencies: {
      "@sentry/junior": "latest",
      "@sentry/node": "^10.0.0",
      hono: "^4.7.0",
    },
    devDependencies: {
      "@hono/node-server": "^1.14.0",
      tsx: "^4.21.0",
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
    ["node_modules/", ".vercel/", ".env", ".env.local", ""].join("\n"),
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

  writeEntryPoint(target);
  writeDevEntry(target);
  writeVercelJson(target);

  log(`Created ${name} at ${target}`);
  log("");
  log(`  cd ${targetDir} && pnpm install && pnpm dev`);
  log("");
}
