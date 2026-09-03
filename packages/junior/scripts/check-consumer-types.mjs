// Install the packed packages so local source files cannot hide type errors.
// Check each public import with Bundler and NodeNext.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pluginApiRoot = path.resolve(packageRoot, "../junior-plugin-api");
const tsc = createRequire(path.join(packageRoot, "package.json")).resolve(
  "typescript/bin/tsc",
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const details = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`,
    );
  }
  return result.stdout ?? "";
}

function typecheck(cwd, config) {
  run(tsc, ["--noEmit", "-p", config, "--pretty", "false"], cwd);
}

function packPackage(packageDirectory, packDirectory) {
  const packOutput = run(
    "pnpm",
    ["pack", "--pack-destination", packDirectory],
    packageDirectory,
  );
  const tarballLine = packOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!tarballLine) {
    throw new Error(`pnpm pack did not print a path for ${packageDirectory}`);
  }
  return path.isAbsolute(tarballLine)
    ? tarballLine
    : path.join(packDirectory, path.basename(tarballLine));
}

function checkPackage(tarball) {
  run(
    "pnpm",
    [
      "exec",
      "attw",
      tarball,
      "--profile",
      "esm-only",
      "--no-summary",
      "--no-emoji",
      "--no-color",
    ],
    packageRoot,
  );
}

async function writeConsumerSource(directory) {
  await fs.writeFile(
    path.join(directory, "index.ts"),
    `import { createApp, defineJuniorPlugins } from "@sentry/junior";
import type { JuniorAppOptions, ModelProfileInput } from "@sentry/junior";
import * as instrumentation from "@sentry/junior/instrumentation";
import * as nitro from "@sentry/junior/nitro";
import * as api from "@sentry/junior/api";
import * as apiSchema from "@sentry/junior/api/schema";
import * as vercel from "@sentry/junior/vercel";
import * as version from "@sentry/junior/version";

const profile: ModelProfileInput = { modelId: "openai/gpt-5" };
const options: JuniorAppOptions = {
  fastModelId: "openai/gpt-5",
  experimental: { subagents: true },
  profiles: { default: profile },
};

void createApp(options);
void defineJuniorPlugins([]);
void instrumentation;
void nitro;
void api;
void apiSchema;
void vercel;
void version;

// @ts-expect-error Model ids must be strings.
const invalidModel: JuniorAppOptions = { fastModelId: 123 };
// @ts-expect-error Experimental feature names form a closed set.
const invalidOptions: JuniorAppOptions = { experimental: { acp: true } };
void invalidModel;
void invalidOptions;
`,
  );
}

async function writeTsconfig(directory, name, module, moduleResolution) {
  await fs.writeFile(
    path.join(directory, `tsconfig.${name}.json`),
    `${JSON.stringify(
      {
        compilerOptions: {
          module,
          moduleResolution,
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const packDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-pack-"),
  );
  const appDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "junior-app-"));
  try {
    const pluginApiTarball = packPackage(pluginApiRoot, packDirectory);
    const juniorTarball = packPackage(packageRoot, packDirectory);
    checkPackage(pluginApiTarball);
    checkPackage(juniorTarball);

    await fs.writeFile(
      path.join(appDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "junior-consumer-types",
          private: true,
          type: "module",
        },
        null,
        2,
      )}\n`,
    );
    await writeConsumerSource(appDirectory);
    await writeTsconfig(appDirectory, "bundler", "ESNext", "Bundler");
    await writeTsconfig(appDirectory, "node-next", "NodeNext", "NodeNext");

    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--no-package-lock",
        pluginApiTarball,
        juniorTarball,
      ],
      appDirectory,
    );
    typecheck(appDirectory, "tsconfig.bundler.json");
    typecheck(appDirectory, "tsconfig.node-next.json");

    console.log(
      `ok: ${path.basename(pluginApiTarball)}, ${path.basename(juniorTarball)}`,
    );
  } finally {
    await fs.rm(packDirectory, { recursive: true, force: true });
    await fs.rm(appDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
