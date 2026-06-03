import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineJuniorPlugins } from "@/app";
import {
  getConfigDefaults,
  setConfigDefaults,
} from "@/chat/configuration/defaults";
import { getAgentPlugins, setAgentPlugins } from "@/chat/plugins/agent-hooks";
import {
  getPluginSkillRoots,
  getPluginProviders,
  setPluginCatalogConfig,
} from "@/chat/plugins/registry";

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
  extraLines: string[] = [],
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
      ...extraLines,
      "config-keys:",
      "  - org",
    ].join("\n"),
    "utf8",
  );
}

afterEach(async () => {
  process.chdir(originalCwd);
  setAgentPlugins([]);
  setPluginCatalogConfig(undefined);
  setConfigDefaults(undefined);
  vi.doUnmock("#junior/config");
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

  it("does not read env plugin packages when trusted plugins are explicit", async () => {
    process.env.JUNIOR_PLUGIN_PACKAGES = "not-json";

    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    expect(getPluginProviders()).toEqual([]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
  });

  it("loads package plugins with trusted runtime plugins", async () => {
    const tempRoot = await makeTempDir();
    await writePluginPackage(tempRoot, "@acme/env-plugin", "env");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/env-plugin": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    await createApp({
      plugins: defineJuniorPlugins([
        "@acme/env-plugin",
        defineJuniorPlugin({
          manifest: {
            name: "dashboard",
            description: "Dashboard plugin",
          },
          hooks: {},
        }),
      ]),
      configDefaults: { "env.org": "sentry" },
    });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "dashboard",
      "env",
    ]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([
      "dashboard",
    ]);
  });

  it("fails loudly when configured plugin package names are invalid", async () => {
    await expect(
      createApp({
        plugins: defineJuniorPlugins(["../plugins"]),
      }),
    ).rejects.toThrow("Plugin package names must be valid npm package names");
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
      plugins: defineJuniorPlugins(["@acme/base-plugin"]),
      configDefaults: { "base.org": "sentry" },
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins(["@acme/next-plugin"]),
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
      plugins: defineJuniorPlugins(["@acme/base-plugin"]),
      configDefaults: { "base.org": "sentry" },
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins(["@acme/missing-plugin"]),
      }),
    ).rejects.toThrow(
      'Plugin package "@acme/missing-plugin" was configured but could not be resolved',
    );

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "base",
    ]);
    expect(getConfigDefaults()).toEqual({ "base.org": "sentry" });
  });

  it("loads trusted plugin instances through createApp", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "trusted",
            description: "Trusted plugin",
            configKeys: ["org"],
          },
          hooks: {},
        }),
      ]),
      configDefaults: { "trusted.org": "sentry" },
    });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "trusted",
    ]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual(["trusted"]);
  });

  it("does not assign app skills to trusted inline plugins", async () => {
    const tempRoot = await makeTempDir();
    await fs.mkdir(path.join(tempRoot, "skills", "notes"), {
      recursive: true,
    });
    process.chdir(tempRoot);

    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "trusted",
            description: "Trusted plugin",
          },
          hooks: {},
        }),
      ]),
    });

    expect(getPluginSkillRoots()).toEqual([]);
  });

  it("assigns package skills to trusted inline plugin packages", async () => {
    const tempRoot = await makeTempDir();
    const packageRoot = path.join(
      tempRoot,
      "node_modules",
      "@acme",
      "trusted-plugin",
    );
    await fs.mkdir(path.join(packageRoot, "skills", "triage"), {
      recursive: true,
    });
    process.chdir(tempRoot);

    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          packageName: "@acme/trusted-plugin",
          manifest: {
            name: "trusted",
            description: "Trusted plugin",
          },
          hooks: {},
        }),
      ]),
    });

    const resolvedTempRoot = await fs.realpath(tempRoot);
    expect(getPluginSkillRoots()).toEqual([
      path.join(
        resolvedTempRoot,
        "node_modules",
        "@acme",
        "trusted-plugin",
        "skills",
      ),
    ]);
  });

  it("applies manifest overrides to trusted plugin inline manifests", async () => {
    await createApp({
      plugins: defineJuniorPlugins(
        [
          defineJuniorPlugin({
            manifest: {
              name: "trusted",
              description: "Trusted plugin",
              credentials: {
                type: "oauth-bearer",
                domains: ["old.example.com"],
                authTokenEnv: "TRUSTED_TOKEN",
              },
            },
            hooks: {},
          }),
        ],
        {
          manifests: {
            trusted: {
              credentials: {
                domains: ["new.example.com"],
              },
            },
          },
        },
      ),
    });

    expect(
      getPluginProviders().map((plugin) => ({
        name: plugin.manifest.name,
        domains: plugin.manifest.credentials?.domains,
      })),
    ).toEqual([{ name: "trusted", domains: ["new.example.com"] }]);
  });

  it("rejects invalid trusted plugin inline manifests before mutating app config", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "invalid",
              description: "Invalid plugin",
              domains: ["api.example.com"],
            },
            hooks: {},
          }),
        ]),
      }),
    ).rejects.toThrow(
      "Plugin invalid domains requires credentials or api-headers",
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("loads trusted plugin instances from the Nitro virtual plugin set", async () => {
    vi.doMock("#junior/config", () => ({
      pluginSet: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "trusted",
            description: "Trusted plugin",
            configKeys: ["org"],
          },
          hooks: {},
        }),
      ]),
      plugins: {
        inlineManifests: [
          {
            manifest: {
              name: "trusted",
              description: "Trusted plugin",
              capabilities: [],
              configKeys: ["trusted.org"],
            },
          },
        ],
      },
      trustedPluginRegistrations: ["trusted"],
    }));

    await createApp({
      configDefaults: { "trusted.org": "sentry" },
    });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "trusted",
    ]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual(["trusted"]);
  });

  it("loads manifest-only package plugins by package name", async () => {
    const tempRoot = await makeTempDir();
    await writePluginPackage(tempRoot, "@acme/full-plugin", "full");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/full-plugin": "1.0.0",
        },
      }),
      "utf8",
    );
    process.chdir(tempRoot);

    await createApp({
      plugins: defineJuniorPlugins(["@acme/full-plugin"]),
    });

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "full",
    ]);
  });

  it("rejects duplicate trusted plugin names before mutating app config", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    expect(() =>
      defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: { name: "dupe", description: "Duplicate plugin" },
        }),
        defineJuniorPlugin({
          manifest: { name: "dupe", description: "Duplicate plugin" },
        }),
      ]),
    ).toThrow('Duplicate plugin registration name "dupe"');

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("rejects invalid trusted plugin names before mutating app config", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    expect(() =>
      defineJuniorPlugin({
        manifest: { name: "GitHub", description: "Invalid plugin" },
        hooks: {},
      }),
    ).toThrow(
      'Junior plugin registration name "GitHub" must be a lowercase plugin identifier',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("rejects legacy state prefixes outside the trusted plugin namespace", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: { name: "trusted", description: "Trusted plugin" },
            legacyStatePrefixes: ["junior:scheduler"],
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Trusted plugin "trusted" legacy state prefix "junior:scheduler" must stay under "junior:trusted"',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });
});
