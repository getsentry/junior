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

/** Reset registry module state and process cwd after plugin package tests. */
export function resetPluginPackageRegistryState(): void {
  configuredPackageNames = [];
  process.chdir(originalCwd);
  vi.resetModules();
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
  await fs.mkdir(path.join(tempRoot, "app", "plugins"), { recursive: true });
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

  await setPluginPackages(
    plugins.map((plugin) => `@acme/${plugin.packageName}`),
  );
  return {
    tempRoot,
    resolvedTempRoot: await fs.realpath(tempRoot),
  };
}

/** Install another temp plugin package in an existing package-app fixture. */
export async function installPackagedPlugin(
  app: PluginPackageAppFixture,
  plugin: PackagedPluginFixture,
): Promise<void> {
  await writePackagedPlugin(app.tempRoot, plugin);
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

function withDefaultDisplayName(manifest: string[]): string[] {
  if (manifest.some((line) => line.startsWith("display-name:"))) {
    return manifest;
  }
  const nameIndex = manifest.findIndex((line) => line.startsWith("name:"));
  if (nameIndex === -1) {
    return manifest;
  }
  const name = manifest[nameIndex]!.slice("name:".length).trim();
  const displayName = name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
  return [
    ...manifest.slice(0, nameIndex + 1),
    `display-name: ${displayName}`,
    ...manifest.slice(nameIndex + 1),
  ];
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
    withDefaultDisplayName(plugin.manifest).join("\n"),
    "utf8",
  );
}
