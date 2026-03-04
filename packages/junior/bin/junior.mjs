#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { positionals } = parseArgs({
  allowPositionals: true,
  strict: false
});

const command = positionals[0];

function writeWrapperFiles(targetDir) {
  // app/api/[...path]/route.js
  const routeDir = path.join(targetDir, "app", "api", "[...path]");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(
    path.join(routeDir, "route.js"),
    'export { GET, POST } from "junior/handler";\n' +
      'export const runtime = "nodejs";\n'
  );

  // app/layout.js
  fs.mkdirSync(path.join(targetDir, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "app", "layout.js"),
    'export { default } from "junior/app/layout";\n'
  );

  // next.config.mjs
  fs.writeFileSync(
    path.join(targetDir, "next.config.mjs"),
    'import { withJunior } from "junior/config";\n' +
      'import workflowNext from "workflow/next";\n\n' +
      'const { withWorkflow } = workflowNext;\n\n' +
      'export default withWorkflow(withJunior());\n'
  );

  // instrumentation.js
  fs.writeFileSync(
    path.join(targetDir, "instrumentation.js"),
    'export { register, onRequestError } from "junior/instrumentation";\n'
  );
}

// ---------------------------------------------------------------------------
// junior init <dir>
// ---------------------------------------------------------------------------
if (command === "init") {
  const dir = positionals[1];
  if (!dir) {
    console.error("usage: junior init <dir>");
    process.exit(1);
  }

  const target = path.resolve(dir);
  fs.mkdirSync(target, { recursive: true });

  const name = path.basename(target);

  // package.json
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
      junior: "latest",
      next: "^16.0.0",
      react: "^19.0.0",
      "react-dom": "^19.0.0",
      "@sentry/nextjs": "^10.0.0",
      workflow: "4.1.0-beta.60"
    }
  };
  fs.writeFileSync(
    path.join(target, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n"
  );

  // app/data/SOUL.md
  const dataDir = path.join(target, "app", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "SOUL.md"),
    `# ${name}\n\nYou are ${name}, a helpful assistant.\n`
  );

  // app/skills/
  const skillsDir = path.join(target, "app", "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, ".gitkeep"), "");

  // app/plugins/
  const pluginsDir = path.join(target, "app", "plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, ".gitkeep"), "");

  // .gitignore
  fs.writeFileSync(
    path.join(target, ".gitignore"),
    [
      "node_modules/",
      ".next/",
      ".env",
      ".env.local",
      ""
    ].join("\n")
  );

  // .env.example
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

  console.log(`Created ${name} at ${target}`);
  console.log();
  console.log(`  cd ${dir} && pnpm install && pnpm dev`);
  console.log();
  process.exit(0);
}

console.error("usage: junior init <dir>");
process.exit(1);
