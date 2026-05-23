import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "@/app";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { getPluginProviders, setPluginConfig } from "@/chat/plugins/registry";

const originalCwd = process.cwd();
const originalPluginPackages = process.env.JUNIOR_PLUGIN_PACKAGES;
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-app-config-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

async function writePluginPackage(
  root: string,
  packageName: string,
  pluginName: string,
): Promise<void> {
  const packageRoot = path.join(
    root,
    "node_modules",
    ...packageName.split("/"),
  );
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      `name: ${pluginName}`,
      `description: ${pluginName} plugin`,
      "config-keys:",
      "  - org",
    ].join("\n"),
    "utf8",
  );
}

afterEach(async () => {
  process.chdir(originalCwd);
  setPluginConfig(undefined);
  setConfigDefaults(undefined);
  if (originalPluginPackages === undefined) {
    delete process.env.JUNIOR_PLUGIN_PACKAGES;
  } else {
    process.env.JUNIOR_PLUGIN_PACKAGES = originalPluginPackages;
  }
  for (const tempDir of tempDirs.splice(0)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("createApp plugin config", () => {
  it("fails loudly when the env plugin package fallback is malformed", async () => {
    process.env.JUNIOR_PLUGIN_PACKAGES = "not-json";

    await expect(createApp()).rejects.toThrow(
      "JUNIOR_PLUGIN_PACKAGES must be valid JSON",
    );
  });

  it("fails loudly when the env plugin package fallback is not a package list", async () => {
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify({
      packages: ["@acme/junior-plugin"],
    });

    await expect(createApp()).rejects.toThrow(
      "JUNIOR_PLUGIN_PACKAGES must be a JSON array of package names",
    );
  });

  it("fails loudly when configured plugin package names are invalid", async () => {
    await expect(
      createApp({
        plugins: {
          packages: ["../plugins"],
        },
      }),
    ).rejects.toThrow("Plugin package names must be valid npm package names");
  });

  it("fails loudly when configured plugin packages are not an array", async () => {
    await expect(
      createApp({
        plugins: {
          packages: "@acme/junior-plugin" as unknown as string[],
        },
      }),
    ).rejects.toThrow("plugins.packages must be an array of package names");
  });

  it("rolls back plugin config when config default validation fails", async () => {
    const tempRoot = await makeTempDir();
    await writePluginPackage(tempRoot, "@acme/base-plugin", "base");
    await writePluginPackage(tempRoot, "@acme/next-plugin", "next");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/base-plugin": "1.0.0",
          "@acme/next-plugin": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    await createApp({
      plugins: { packages: ["@acme/base-plugin"] },
      configDefaults: { "base.org": "sentry" },
    });

    await expect(
      createApp({
        plugins: { packages: ["@acme/next-plugin"] },
        configDefaults: { "missing.org": "sentry" },
      }),
    ).rejects.toThrow(
      'configDefaults: "missing.org" is not a registered plugin config key',
    );

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "base",
    ]);
    expect(getConfigDefaults()).toEqual({ "base.org": "sentry" });
  });

  it("fails startup and rolls back config when a configured plugin package is missing", async () => {
    const tempRoot = await makeTempDir();
    await writePluginPackage(tempRoot, "@acme/base-plugin", "base");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/base-plugin": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    await createApp({
      plugins: { packages: ["@acme/base-plugin"] },
      configDefaults: { "base.org": "sentry" },
    });

    await expect(
      createApp({
        plugins: { packages: ["@acme/missing-plugin"] },
      }),
    ).rejects.toThrow(
      'Plugin package "@acme/missing-plugin" was configured but could not be resolved',
    );

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "base",
    ]);
    expect(getConfigDefaults()).toEqual({ "base.org": "sentry" });
  });
});
