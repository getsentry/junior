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

  it("does not read env plugin packages when plugins are explicit", async () => {
    process.env.JUNIOR_PLUGIN_PACKAGES = "not-json";

    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    expect(getPluginProviders()).toEqual([]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
  });

  it("loads package plugins with runtime hook plugins", async () => {
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

  it("loads plugin instances through createApp", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "hooked",
            description: "Runtime plugin",
            configKeys: ["org"],
          },
          hooks: {},
        }),
      ]),
      configDefaults: { "hooked.org": "sentry" },
    });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "hooked",
    ]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual(["hooked"]);
  });

  it("rejects incomplete plugin egress credential hooks", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "example",
              description: "Example plugin",
              domains: ["api.example.com"],
            },
            hooks: {
              grantForEgress() {
                return { name: "default", access: "read" };
              },
            },
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Plugin "example" egress credential hooks must include both grantForEgress and issueCredential.',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("rejects plugin egress credential hooks without manifest domains", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "example",
              description: "Example plugin",
            },
            hooks: {
              grantForEgress() {
                return { name: "default", access: "read" };
              },
              issueCredential() {
                return {
                  type: "needed",
                  message: "Example credentials are unavailable.",
                };
              },
            },
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Plugin "example" egress credential hooks require manifest.domains to list sandbox egress hosts.',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("rejects plugin OAuth without credentials or egress credential hooks", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "example",
              description: "Example plugin",
              oauth: {
                clientIdEnv: "EXAMPLE_CLIENT_ID",
                clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
                authorizeEndpoint: "https://example.com/oauth/authorize",
                tokenEndpoint: "https://example.com/oauth/token",
              },
            },
            hooks: {},
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Plugin "example" manifest.oauth without oauth-bearer credentials requires egress credential hooks.',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("loads plugins with egress credential hooks", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "example",
            description: "Example plugin",
            domains: ["api.example.com"],
          },
          hooks: {
            grantForEgress() {
              return { name: "default", access: "read" };
            },
            issueCredential() {
              return {
                type: "needed",
                message: "Example credentials are unavailable.",
              };
            },
          },
        }),
      ]),
    });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "example",
    ]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual(["example"]);
  });

  it("does not assign app skills to runtime hook inline plugins", async () => {
    const tempRoot = await makeTempDir();
    await fs.mkdir(path.join(tempRoot, "skills", "notes"), {
      recursive: true,
    });
    process.chdir(tempRoot);

    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "hooked",
            description: "Runtime plugin",
          },
          hooks: {},
        }),
      ]),
    });

    expect(getPluginSkillRoots()).toEqual([]);
  });

  it("assigns package skills to runtime hook inline plugin packages", async () => {
    const tempRoot = await makeTempDir();
    const packageRoot = path.join(
      tempRoot,
      "node_modules",
      "@acme",
      "hooked-plugin",
    );
    await fs.mkdir(path.join(packageRoot, "skills", "triage"), {
      recursive: true,
    });
    process.chdir(tempRoot);

    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          packageName: "@acme/hooked-plugin",
          manifest: {
            name: "hooked",
            description: "Runtime plugin",
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
        "hooked-plugin",
        "skills",
      ),
    ]);
  });

  it("applies manifest overrides to plugin inline manifests", async () => {
    await createApp({
      plugins: defineJuniorPlugins(
        [
          defineJuniorPlugin({
            manifest: {
              name: "hooked",
              description: "Runtime plugin",
              credentials: {
                type: "oauth-bearer",
                domains: ["old.example.com"],
                authTokenEnv: "HOOKED_TOKEN",
              },
            },
            hooks: {},
          }),
        ],
        {
          manifests: {
            hooked: {
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
    ).toEqual([{ name: "hooked", domains: ["new.example.com"] }]);
  });

  it("rejects invalid plugin inline manifests before mutating app config", async () => {
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
      'Plugin "invalid" manifest.domains requires egress credential hooks when no generic credentials or apiHeaders are configured.',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });

  it("loads plugin instances from the Nitro virtual plugin set", async () => {
    vi.doMock("#junior/config", () => ({
      pluginSet: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "hooked",
            description: "Runtime plugin",
            configKeys: ["org"],
          },
          hooks: {},
        }),
      ]),
      plugins: {
        inlineManifests: [
          {
            manifest: {
              name: "hooked",
              description: "Runtime plugin",
              capabilities: [],
              configKeys: ["hooked.org"],
            },
          },
        ],
      },
      pluginHookRegistrations: ["hooked"],
    }));

    await createApp({
      configDefaults: { "hooked.org": "sentry" },
    });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "hooked",
    ]);
    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual(["hooked"]);
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

  it("rejects duplicate plugin names before mutating app config", async () => {
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

  it("rejects invalid plugin names before mutating app config", async () => {
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

  it("rejects legacy state prefixes outside the plugin namespace", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: { name: "hooked", description: "Runtime plugin" },
            legacyStatePrefixes: ["junior:scheduler"],
          }),
        ]),
      }),
    ).rejects.toThrow(
      'Plugin "hooked" legacy state prefix "junior:scheduler" must stay under "junior:hooked"',
    );

    expect(getAgentPlugins().map((plugin) => plugin.name)).toEqual([]);
    expect(getPluginProviders()).toEqual([]);
  });
});
