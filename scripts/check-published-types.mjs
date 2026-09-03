// Check built package archives so workspace source files cannot hide type errors.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packagesRoot = path.join(workspaceRoot, "packages");
const juniorRoot = path.join(packagesRoot, "junior");
const pluginApiRoot = path.join(packagesRoot, "junior-plugin-api");
const tsc = createRequire(path.join(juniorRoot, "package.json")).resolve(
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

async function listPublishedCodePackageDirectories() {
  const entries = await fs.readdir(packagesRoot, { withFileTypes: true });
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(packagesRoot, entry.name);
    const packagePath = path.join(directory, "package.json");
    let packageJson;
    try {
      packageJson = JSON.parse(await fs.readFile(packagePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (packageJson.private === false && packageJson.exports !== undefined) {
      directories.push(directory);
    }
  }
  return directories.sort();
}

function packBuiltPackage(packageDirectory, packDirectory, npmCacheDirectory) {
  const output = run(
    "npm",
    [
      "--cache",
      npmCacheDirectory,
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      packDirectory,
      "--json",
    ],
    packageDirectory,
  );
  const packed = JSON.parse(output)[0];
  if (!packed?.filename) {
    throw new Error(`npm pack did not name an archive for ${packageDirectory}`);
  }
  return path.isAbsolute(packed.filename)
    ? packed.filename
    : path.join(packDirectory, packed.filename);
}

function packConsumerDependency(packageDirectory, packDirectory) {
  const output = run(
    "pnpm",
    ["pack", "--pack-destination", packDirectory],
    packageDirectory,
  );
  const lastLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) {
    throw new Error(
      `pnpm pack did not name an archive for ${packageDirectory}`,
    );
  }
  return path.isAbsolute(lastLine)
    ? lastLine
    : path.join(packDirectory, path.basename(lastLine));
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
    workspaceRoot,
  );
}

function typecheck(directory, config) {
  run(tsc, ["--noEmit", "-p", config, "--pretty", "false"], directory);
}

async function writeConsumerFiles(directory) {
  await fs.writeFile(
    path.join(directory, "package.json"),
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

  const configs = [
    ["bundler", "ESNext", "Bundler"],
    ["node-next", "NodeNext", "NodeNext"],
  ];
  for (const [name, module, moduleResolution] of configs) {
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
}

async function checkJuniorConsumer(packDirectory, npmCacheDirectory) {
  const appDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "junior-app-"));
  try {
    const pluginApiTarball = packConsumerDependency(
      pluginApiRoot,
      packDirectory,
    );
    const juniorTarball = packConsumerDependency(juniorRoot, packDirectory);
    await writeConsumerFiles(appDirectory);
    run(
      "npm",
      [
        "--cache",
        npmCacheDirectory,
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
  } finally {
    await fs.rm(appDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const packDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-package-types-"),
  );
  const npmCacheDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-npm-cache-"),
  );
  try {
    const packageDirectories = await listPublishedCodePackageDirectories();
    for (const packageDirectory of packageDirectories) {
      checkPackage(
        packBuiltPackage(packageDirectory, packDirectory, npmCacheDirectory),
      );
    }
    await checkJuniorConsumer(packDirectory, npmCacheDirectory);
    console.log(`ok: checked types for ${packageDirectories.length} packages`);
  } finally {
    await fs.rm(packDirectory, { recursive: true, force: true });
    await fs.rm(npmCacheDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
