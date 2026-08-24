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

function tscProject(cwd, config) {
  const result = spawnSync(tsc, ["--noEmit", "-p", config, "--pretty", "false"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim(),
  };
}

async function writeApp(dir, name, experimentalBody) {
  await fs.writeFile(
    path.join(dir, `${name}.ts`),
    `import { createApp } from "@sentry/junior";\n\nawait createApp({\n  experimental: ${experimentalBody},\n});\n`,
  );
  await fs.writeFile(
    path.join(dir, `tsconfig.${name}.json`),
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
        include: [`${name}.ts`],
      },
      null,
      2,
    )}\n`,
  );
}

async function main() {
  const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "junior-pack-"));
  const appDir = await fs.mkdtemp(path.join(os.tmpdir(), "junior-app-"));
  try {
    const packOut = run("pnpm", ["pack", "--pack-destination", packDir], packageRoot);
    const tarballLine = packOut
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!tarballLine) {
      throw new Error("pnpm pack did not print a tarball path");
    }
    const tarball = path.isAbsolute(tarballLine)
      ? tarballLine
      : path.join(packDir, path.basename(tarballLine));

    await fs.writeFile(
      path.join(appDir, "package.json"),
      `${JSON.stringify({ name: "junior-app-types", private: true, type: "module" }, null, 2)}\n`,
    );
    await writeApp(appDir, "ok", "{ subagents: true }");
    await writeApp(appDir, "bad", "{ acp: true }");
    run("npm", ["install", "--no-save", "--no-package-lock", tarball], appDir);

    const ok = tscProject(appDir, "tsconfig.ok.json");
    if (!ok.ok) {
      throw new Error(`known feature should typecheck:\n${ok.output}`);
    }

    const bad = tscProject(appDir, "tsconfig.bad.json");
    if (bad.ok) {
      throw new Error("unknown feature should fail typecheck");
    }
    if (!/\bacp\b|experimental|known properties/i.test(bad.output)) {
      throw new Error(`unknown feature failed for the wrong reason:\n${bad.output}`);
    }

    console.log(`ok: ${path.basename(tarball)}`);
  } finally {
    await fs.rm(packDir, { recursive: true, force: true });
    await fs.rm(appDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
