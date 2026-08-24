import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${details ? `:\n${details}` : ""}`,
    );
  }
  return result.stdout;
}

function typecheckProject(dir, typescriptBin, tsconfigName) {
  const result = spawnSync(
    typescriptBin,
    ["--noEmit", "-p", tsconfigName, "--pretty", "false"],
    {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

async function writeConsumerFixture(dir) {
  await fs.writeFile(
    path.join(dir, "package.json"),
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
    path.join(dir, "tsconfig.base.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "bundler",
          target: "ES2022",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: [],
        },
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(dir, "tsconfig.valid.json"),
    `${JSON.stringify(
      {
        extends: "./tsconfig.base.json",
        include: ["valid.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(dir, "tsconfig.invalid.json"),
    `${JSON.stringify(
      {
        extends: "./tsconfig.base.json",
        include: ["invalid.ts"],
      },
      null,
      2,
    )}\n`,
  );
  await fs.writeFile(
    path.join(dir, "valid.ts"),
    `import { createApp } from "@sentry/junior";

await createApp({
  experimental: {
    subagents: true,
  },
});
`,
  );
  await fs.writeFile(
    path.join(dir, "invalid.ts"),
    `import { createApp } from "@sentry/junior";

await createApp({
  experimental: {
    acp: true,
  },
});
`,
  );
}

/** Pack the local package and prove consumer tsc sees closed experimental keys. */
export async function checkConsumerTypes(options = {}) {
  const tscBin =
    options.typescriptBin ?? requireFromPackage.resolve("typescript/bin/tsc");
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "junior-pack-"));
  const consumerDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-consumer-"),
  );

  try {
    const packOutput = run("pnpm", ["pack", "--pack-destination", packDir], {
      cwd: packageRoot,
    });
    const tarballName = packOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarballName) {
      throw new Error("pnpm pack did not report a tarball path");
    }
    const tarballPath = path.isAbsolute(tarballName)
      ? tarballName
      : path.join(packDir, path.basename(tarballName));

    await writeConsumerFixture(consumerDir);
    run("npm", ["install", "--no-save", "--no-package-lock", tarballPath], {
      cwd: consumerDir,
    });

    const valid = typecheckProject(consumerDir, tscBin, "tsconfig.valid.json");
    if (valid.status !== 0) {
      throw new Error(
        `known experimental key should typecheck for consumers:\n${valid.output}`,
      );
    }

    const invalid = typecheckProject(
      consumerDir,
      tscBin,
      "tsconfig.invalid.json",
    );
    if (invalid.status === 0) {
      throw new Error(
        "unknown experimental key should fail consumer typecheck, but tsc exited 0",
      );
    }
    if (
      !/acp|experimental|ExperimentalFeaturesConfig|did not exist|not assignable|Object literal may only specify known properties/i.test(
        invalid.output,
      )
    ) {
      throw new Error(
        `unknown experimental key failed for an unexpected reason:\n${invalid.output}`,
      );
    }

    return {
      tarballPath,
      invalidOutput: invalid.output,
    };
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
    await fs.rm(consumerDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await checkConsumerTypes();
  console.log(`Consumer types OK via ${path.basename(result.tarballPath)}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
