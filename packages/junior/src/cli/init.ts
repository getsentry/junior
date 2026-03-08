import fs from "node:fs";
import path from "node:path";

function writeRouteModule(filePath: string, exportLine: string): void {
  fs.writeFileSync(filePath, `${exportLine}\nexport const runtime = "nodejs";\n`);
}

function writeWrapperFiles(targetDir: string): void {
  const routeDir = path.join(targetDir, "app", "api", "[...path]");
  fs.mkdirSync(routeDir, { recursive: true });
  writeRouteModule(path.join(routeDir, "route.js"), 'export { GET, POST } from "@sentry/junior/handler";');

  const queueRouteDir = path.join(targetDir, "app", "api", "queue", "callback");
  fs.mkdirSync(queueRouteDir, { recursive: true });
  writeRouteModule(
    path.join(queueRouteDir, "route.js"),
    'export { POST } from "@sentry/junior/handlers/queue-callback";'
  );

  fs.mkdirSync(path.join(targetDir, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "app", "layout.js"),
    'export { default } from "@sentry/junior/app/layout";\n'
  );

  fs.writeFileSync(
    path.join(targetDir, "next.config.mjs"),
    'import { withJunior } from "@sentry/junior/config";\n' +
      'export default withJunior();\n'
  );

  fs.writeFileSync(
    path.join(targetDir, "instrumentation.js"),
    'export { register, onRequestError } from "@sentry/junior/instrumentation";\n'
  );
}

export async function runInit(dir: string, log: (line: string) => void = console.log): Promise<void> {
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
      dev: "next dev",
      build: "next build",
      start: "next start"
    },
    dependencies: {
      "@sentry/junior": "latest",
      next: "^16.0.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      "@sentry/nextjs": "^10.0.0"
    }
  };
  fs.writeFileSync(path.join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);

  const dataDir = path.join(target, "app", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "SOUL.md"), `# ${name}\n\nYou are ${name}, a helpful assistant.\n`);

  const skillsDir = path.join(target, "app", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, ".gitkeep"), "");

  const pluginsDir = path.join(target, "app", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, ".gitkeep"), "");

  fs.writeFileSync(path.join(target, ".gitignore"), ["node_modules/", ".next/", ".env", ".env.local", ""].join("\n"));
  fs.writeFileSync(
    path.join(target, ".env.example"),
    [
      "SLACK_BOT_TOKEN=",
      "SLACK_SIGNING_SECRET=",
      "JUNIOR_BOT_NAME=",
      "AI_MODEL=",
      "AI_FAST_MODEL=",
      "REDIS_URL=",
      "NEXT_PUBLIC_SENTRY_DSN=",
      ""
    ].join("\n")
  );

  writeWrapperFiles(target);

  log(`Created ${name} at ${target}`);
  log("");
  log(`  cd ${targetDir} && pnpm install && pnpm dev`);
  log("");
}
