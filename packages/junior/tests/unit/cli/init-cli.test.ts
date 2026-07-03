import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "@/cli/check";
import { runInit } from "@/cli/init";

const tempRoots: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
const examplePackageJsonPath = path.join(
  repoRoot,
  "apps",
  "example",
  "package.json",
);

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function normalizeText(source: string): string {
  return source.trim().replace(/\n{3,}/g, "\n\n");
}

function removeExampleDashboardServerConfig(source: string): string {
  return normalizeText(
    source
      .replace(
        /import \{\n  exampleDashboardAuthRequired,\n  exampleDashboardMockConversations,\n\} from "\.\/dashboard\.ts";\n/,
        "",
      )
      .replace(/  dashboard: \{[\s\S]*?  \},\n  plugins,/, "  plugins,")
      .replace(/  configDefaults: \{[\s\S]*?  \},\n/, ""),
  );
}

function removeExampleDashboardNitroConfig(source: string): string {
  return normalizeText(
    source
      .replace(
        /import \{\n  exampleDashboardAuthRequired,\n  exampleDashboardMockConversations,\n\} from "\.\/dashboard\.ts";\n/,
        "",
      )
      .replace(
        /      dashboard: \{[\s\S]*?      \},\n      plugins:/,
        "      plugins:",
      ),
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("init cli", () => {
  it("writes the scaffold into an empty directory", async () => {
    const target = makeTempDir("junior-init-empty-");

    await runInit(target, () => undefined);

    expect(fs.existsSync(path.join(target, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "server.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "api"))).toBe(false);
    expect(fs.existsSync(path.join(target, "vercel.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "nitro.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "plugins.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "vite.config.ts"))).toBe(false);
    expect(fs.existsSync(path.join(target, "tsconfig.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "WORLD.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "DESCRIPTION.md"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(target, ".github", "workflows", "ci.yml")),
    ).toBe(true);

    const workflow = fs.readFileSync(
      path.join(target, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm check");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("pnpm install");

    const vercelConfig = readJsonFile<Record<string, unknown>>(
      path.join(target, "vercel.json"),
    );
    expect(vercelConfig.framework).toBe("nitro");
    expect(vercelConfig.buildCommand).toBe(
      "pnpm exec junior upgrade && pnpm build",
    );
    expect(vercelConfig.crons).toBeUndefined();
    expect(vercelConfig.functions).toBeUndefined();

    const serverEntry = fs.readFileSync(path.join(target, "server.ts"), "utf8");
    expect(serverEntry).toContain(
      'import { initSentry } from "@sentry/junior/instrumentation";',
    );
    expect(serverEntry).toContain(
      'import { createApp } from "@sentry/junior";',
    );
    expect(serverEntry).toContain('import { plugins } from "./plugins.ts";');
    expect(serverEntry).toContain("createApp({");
    expect(serverEntry).toContain("plugins,");

    const nitroConfig = fs.readFileSync(
      path.join(target, "nitro.config.ts"),
      "utf8",
    );
    expect(nitroConfig).toContain(
      'import { juniorNitro } from "@sentry/junior/nitro";',
    );
    expect(nitroConfig).toContain('preset: "vercel"');
    expect(nitroConfig).toContain("juniorNitro({");
    expect(nitroConfig).toContain('plugins: "./plugins"');
    expect(nitroConfig).toContain('"/**": { handler: "./server.ts" }');

    const tsConfig = readJsonFile<Record<string, unknown>>(
      path.join(target, "tsconfig.json"),
    );
    expect(tsConfig.extends).toBe("nitro/tsconfig");

    const pluginsFile = fs.readFileSync(
      path.join(target, "plugins.ts"),
      "utf8",
    );
    expect(pluginsFile).toContain(
      'import { defineJuniorPlugins } from "@sentry/junior";',
    );
    expect(pluginsFile).toContain(
      'import { createMemoryPlugin } from "@sentry/junior-memory";',
    );
    expect(pluginsFile).toContain("defineJuniorPlugins(");
    expect(pluginsFile).toContain("createMemoryPlugin()");
    expect(pluginsFile).toContain('"@sentry/junior-maintenance"');

    const pkg = readJsonFile<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    }>(path.join(target, "package.json"));
    expect(pkg.dependencies["@sentry/junior"]).toBe("latest");
    expect(pkg.dependencies["@sentry/junior-memory"]).toBe("latest");
    expect(pkg.dependencies["@sentry/junior-maintenance"]).toBe("latest");
    expect(pkg.devDependencies.nitro).toBeDefined();
    expect(pkg.devDependencies.vite).toBeUndefined();
    expect(pkg.devDependencies.vercel).toBeUndefined();
    expect(pkg.scripts.dev).toBe("nitro dev");
    expect(pkg.scripts.check).toBe("junior check");
    expect(pkg.scripts.build).toBe("junior snapshot create && nitro build");
    expect(pkg.scripts.preview).toBe("nitro preview");
    expect(pkg.scripts.typecheck).toBe("tsc --noEmit");

    const envExample = fs.readFileSync(
      path.join(target, ".env.example"),
      "utf8",
    );
    expect(envExample).toContain("CRON_SECRET=");
    expect(envExample).toContain("JUNIOR_SLASH_COMMAND=");
    expect(envExample).toContain("DATABASE_URL=");
    expect(envExample).toContain("JUNIOR_DATABASE_DRIVER=");

    const checkLines: string[] = [];
    await runCheck(target, {
      info: (line) => checkLines.push(line),
      warn: (line) => checkLines.push(line),
      error: (line) => checkLines.push(line),
    });
    expect(checkLines).toContain("✓ deployment config");
  });

  it("keeps the Nitro scaffold aligned with the example app", async () => {
    const target = makeTempDir("junior-init-example-parity-");

    await runInit(target, () => undefined);

    const scaffoldPackage = readJsonFile<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    }>(path.join(target, "package.json"));
    const examplePackage = readJsonFile<{
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
      scripts: Record<string, string>;
    }>(examplePackageJsonPath);

    const exampleCoreScriptNames = Object.keys(examplePackage.scripts)
      .filter(
        (name) =>
          (name === "preview" || !name.startsWith("pre")) &&
          !name.startsWith("post"),
      )
      .sort();
    expect(Object.keys(scaffoldPackage.scripts).sort()).toEqual(
      ["check", ...exampleCoreScriptNames].sort(),
    );
    expect(
      Object.fromEntries(
        exampleCoreScriptNames.map((name) => [
          name,
          scaffoldPackage.scripts[name],
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        exampleCoreScriptNames.map((name) => [
          name,
          examplePackage.scripts[name],
        ]),
      ),
    );

    const scaffoldNonPluginDeps = Object.fromEntries(
      Object.entries(scaffoldPackage.dependencies).filter(
        ([name]) => !name.startsWith("@sentry/junior"),
      ),
    );
    const exampleNonPluginDeps = Object.fromEntries(
      Object.entries(examplePackage.dependencies).filter(
        ([name]) => !name.startsWith("@sentry/junior"),
      ),
    );
    expect(scaffoldNonPluginDeps).toEqual(exampleNonPluginDeps);
    expect(scaffoldPackage.devDependencies).toEqual(
      examplePackage.devDependencies,
    );

    const scaffoldVercelConfig = readJsonFile<Record<string, unknown>>(
      path.join(target, "vercel.json"),
    );
    const exampleVercelConfig = readJsonFile<Record<string, unknown>>(
      path.join(repoRoot, "apps", "example", "vercel.json"),
    );
    expect(scaffoldVercelConfig).toEqual(exampleVercelConfig);

    const scaffoldNitroConfig = fs.readFileSync(
      path.join(target, "nitro.config.ts"),
      "utf8",
    );
    const exampleNitroConfig = fs.readFileSync(
      path.join(repoRoot, "apps", "example", "nitro.config.ts"),
      "utf8",
    );
    expect(normalizeText(scaffoldNitroConfig)).toEqual(
      removeExampleDashboardNitroConfig(exampleNitroConfig),
    );

    const scaffoldServer = fs.readFileSync(
      path.join(target, "server.ts"),
      "utf8",
    );
    const exampleServer = fs.readFileSync(
      path.join(repoRoot, "apps", "example", "server.ts"),
      "utf8",
    );
    expect(normalizeText(scaffoldServer)).toEqual(
      removeExampleDashboardServerConfig(exampleServer),
    );

    const scaffoldTsConfig = readJsonFile<Record<string, unknown>>(
      path.join(target, "tsconfig.json"),
    );
    const exampleTsConfig = readJsonFile<Record<string, unknown>>(
      path.join(repoRoot, "apps", "example", "tsconfig.json"),
    );
    expect(scaffoldTsConfig).toEqual(exampleTsConfig);
  });

  it("refuses to initialize a non-empty directory", async () => {
    const target = makeTempDir("junior-init-non-empty-");
    fs.writeFileSync(path.join(target, "README.md"), "# existing\n");

    await expect(runInit(target, () => undefined)).rejects.toThrow(
      "refusing to initialize non-empty directory",
    );
  });

  it("refuses to initialize a file path", async () => {
    const targetRoot = makeTempDir("junior-init-file-path-");
    const filePath = path.join(targetRoot, "not-a-dir.txt");
    fs.writeFileSync(filePath, "hello");

    await expect(runInit(filePath, () => undefined)).rejects.toThrow(
      "refusing to initialize non-directory path",
    );
  });
});
