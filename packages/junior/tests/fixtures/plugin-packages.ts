import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, vi } from "vitest";
import type { PluginCatalogConfig } from "@/chat/plugins/types";

const originalCwd = process.cwd();
let configuredPackageNames: string[] = [];

export interface PackagedPluginFixture {
  packageName: string;
  manifest: string[];
  skillName?: string;
}

export interface PluginPackageAppFixture {
  resolvedTempRoot: string;
  tempRoot: string;
}

/** Reset registry module state and process cwd after package-discovery tests. */
export function resetPluginPackageRegistryState(): void {
  configuredPackageNames = [];
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/discovery");
}

/** Configure the package list through the production registry config surface. */
export async function setPluginPackages(packageNames: string[]): Promise<void> {
  configuredPackageNames = packageNames;
  await setPluginCatalogConfigForTest({ packages: packageNames });
}

/** Apply a partial plugin catalog config while preserving the active package list. */
export async function setPluginCatalogConfigForTest(
  config: PluginCatalogConfig,
): Promise<void> {
  const { setPluginCatalogConfig } = await import("@/chat/plugins/registry");
  setPluginCatalogConfig({
    ...config,
    packages: config.packages ?? configuredPackageNames,
  });
}

/** Assert lazy registry validation fails when providers are materialized. */
export async function expectPluginRegistryLoadFailure(
  packageNames: string[],
  message: string,
): Promise<void> {
  await setPluginPackages(packageNames);
  const registry = await import("@/chat/plugins/registry");
  expect(() => registry.getPluginProviders()).toThrow(message);
}

/** Create a temp app with installed plugin packages and empty local plugin roots. */
export async function createPluginPackageApp(
  plugins: PackagedPluginFixture[],
): Promise<PluginPackageAppFixture> {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-plugin-package-"),
  );
  for (const plugin of plugins) {
    await writePackagedPlugin(tempRoot, plugin);
  }
  await fs.writeFile(
    path.join(tempRoot, "package.json"),
    JSON.stringify({
      name: "temp-junior-app",
      private: true,
      dependencies: Object.fromEntries(
        plugins.map((plugin) => [`@acme/${plugin.packageName}`, "1.0.0"]),
      ),
    }),
    "utf8",
  );
  process.chdir(tempRoot);

  vi.resetModules();
  vi.doMock("@/chat/discovery", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/chat/discovery")>()),
    pluginRoots: () => [],
  }));

  await setPluginPackages(
    plugins.map((plugin) => `@acme/${plugin.packageName}`),
  );
  return {
    tempRoot,
    resolvedTempRoot: await fs.realpath(tempRoot),
  };
}

/** Build the expected skill root path for an installed temp plugin package. */
export function pluginSkillRoot(
  app: PluginPackageAppFixture,
  packageName: string,
): string {
  return path.join(
    app.resolvedTempRoot,
    "node_modules",
    "@acme",
    packageName,
    "skills",
  );
}

async function writePackagedPlugin(
  tempRoot: string,
  plugin: PackagedPluginFixture,
): Promise<void> {
  const packageRoot = path.join(
    tempRoot,
    "node_modules",
    "@acme",
    plugin.packageName,
  );
  const skillsDir = path.join(
    packageRoot,
    "skills",
    plugin.skillName ?? "demo",
  );
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    plugin.manifest.join("\n"),
    "utf8",
  );
}
