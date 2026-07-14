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
import { getPlugins, setPlugins } from "@/chat/plugins/agent-hooks";
import { setDashboardConversationLinkOptions } from "@/chat/slack/dashboard-link";
import { buildSlackReplyFooter } from "@/chat/slack/footer";
import { pluginCatalogRuntime } from "@/chat/plugins/catalog-runtime";
import { validatePluginRegistrations } from "@/chat/plugins/validation";
import { createSlackWebhookTestClient } from "../fixtures/slack/webhook-client";

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
      `display-name: ${pluginName
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ")}`,
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
  setPlugins([]);
  pluginCatalogRuntime.setConfig(undefined);
  setConfigDefaults(undefined);
  setDashboardConversationLinkOptions(undefined);
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
  it("routes Slack webhooks through the production Slack handler", async () => {
    const app = await createApp({
      plugins: defineJuniorPlugins([]),
    });
    const slackWebhookClient = createSlackWebhookTestClient({
      signingSecret: "test-signing-secret",
    });

    const response = await app.fetch(
      slackWebhookClient.event({
        type: "url_verification",
        challenge: "route-ok",
      }),
    );

    await expect(response.json()).resolves.toEqual({
      challenge: "route-ok",
    });
  });

  it("routes GitHub webhooks through the core resource-event handler", async () => {
    const app = await createApp({
      plugins: defineJuniorPlugins([]),
    });

    const response = await app.fetch(
      new Request("https://example.test/api/webhooks/github", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.text()).resolves.toBe("Unauthorized");
  });

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

    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
  });

  it("validates sandbox egress trace propagation domains from app options", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "base",
            displayName: "Base",
            description: "Base plugin",
          },
          hooks: {},
        }),
      ]),
    });

    await expect(
      createApp({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "next",
              displayName: "Next",
              description: "Next plugin",
            },
            hooks: {},
          }),
        ]),
        sandbox: {
          egressTracePropagationDomains: ["api.*.sentry.io"],
        },
      }),
    ).rejects.toThrow(
      "sandbox.egressTracePropagationDomains entries must be exact domains or leading wildcard domains",
    );
    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["base"]);
    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([
      "base",
    ]);
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
            displayName: "Dashboard",
            description: "Dashboard plugin",
          },
          hooks: {},
        }),
      ]),
      configDefaults: { "env.org": "sentry" },
    });

    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["dashboard", "env"]);
    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([
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

    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["base"]);
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

    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["base"]);
    expect(getConfigDefaults()).toEqual({ "base.org": "sentry" });
  });

  it("loads plugin instances through createApp", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "hooked",
            displayName: "Hooked",
            description: "Runtime plugin",
            configKeys: ["org"],
          },
          hooks: {},
        }),
      ]),
      configDefaults: { "hooked.org": "sentry" },
    });

    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["hooked"]);
    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([
      "hooked",
    ]);
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
              displayName: "Example",
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

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
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
              displayName: "Example",
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

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
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
              displayName: "Example",
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

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
  });

  it("loads plugins with egress credential hooks", async () => {
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "example",
            displayName: "Example",
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

    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["example"]);
    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([
      "example",
    ]);
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
            displayName: "Hooked",
            description: "Runtime plugin",
          },
          hooks: {},
        }),
      ]),
    });

    expect(pluginCatalogRuntime.getSkillRoots()).toEqual([]);
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
            displayName: "Hooked",
            description: "Runtime plugin",
          },
          hooks: {},
        }),
      ]),
    });

    const resolvedTempRoot = await fs.realpath(tempRoot);
    expect(pluginCatalogRuntime.getSkillRoots()).toEqual([
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
              displayName: "Hooked",
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
      pluginCatalogRuntime.getProviders().map((plugin) => ({
        name: plugin.manifest.name,
        domains: plugin.manifest.credentials?.domains,
      })),
    ).toEqual([{ name: "hooked", domains: ["new.example.com"] }]);
  });

  it("rejects runtime registrations that drift from the loaded manifest", async () => {
    const tempRoot = await makeTempDir();
    process.chdir(tempRoot);

    const registration = defineJuniorPlugin({
      manifest: {
        name: "hooked",
        displayName: "Hooked",
        description: "Runtime plugin",
      },
      hooks: {},
    });
    pluginCatalogRuntime.setConfig({
      inlineManifests: [
        {
          manifest: {
            name: "hooked",
            displayName: "Different Hooked",
            description: "Runtime plugin",
            capabilities: [],
            configKeys: [],
          },
        },
      ],
    });

    expect(() => validatePluginRegistrations([registration])).toThrow(
      'Plugin registration "hooked" manifest does not match the loaded plugin manifest. Use one canonical manifest source for runtime hook plugins.',
    );
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
              displayName: "Invalid",
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

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
  });

  it("loads plugin instances from the Nitro virtual plugin set", async () => {
    vi.doMock("#junior/config", () => ({
      createDashboardApp: undefined,
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "hooked",
            displayName: "Hooked",
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
              displayName: "Hooked",
              description: "Runtime plugin",
              capabilities: [],
              configKeys: ["hooked.org"],
            },
          },
        ],
      },
      pluginRuntimeRegistrations: ["hooked"],
    }));

    await createApp({
      configDefaults: { "hooked.org": "sentry" },
    });

    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["hooked"]);
    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([
      "hooked",
    ]);
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

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(
      pluginCatalogRuntime.getProviders().map((plugin) => plugin.manifest.name),
    ).toEqual(["full"]);
  });

  it("rejects duplicate plugin names before mutating app config", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    expect(() =>
      defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "dupe",
            displayName: "Dupe",
            description: "Duplicate plugin",
          },
        }),
        defineJuniorPlugin({
          manifest: {
            name: "dupe",
            displayName: "Dupe",
            description: "Duplicate plugin",
          },
        }),
      ]),
    ).toThrow('Duplicate plugin registration name "dupe"');

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
  });

  it("rejects invalid plugin names before mutating app config", async () => {
    await createApp({
      plugins: defineJuniorPlugins([]),
    });

    expect(() =>
      defineJuniorPlugin({
        manifest: {
          name: "GitHub",
          displayName: "GitHub",
          description: "Invalid plugin",
        },
        hooks: {},
      }),
    ).toThrow(
      'Junior plugin registration name "GitHub" must be a lowercase plugin identifier',
    );

    expect(getPlugins().map((plugin) => plugin.manifest.name)).toEqual([]);
    expect(pluginCatalogRuntime.getProviders()).toEqual([]);
  });

  it("rejects top-level plugin registration names", () => {
    expect(() =>
      defineJuniorPlugin({
        name: "legacy",
        manifest: {
          name: "legacy",
          displayName: "Legacy",
          description: "Legacy plugin",
        },
      } as Parameters<typeof defineJuniorPlugin>[0] & { name: string }),
    ).toThrow("defineJuniorPlugin() uses manifest.name for identity.");
  });

  it("forwards virtual plugin API route apps into dashboard setup", async () => {
    const pluginRouteApp = {
      fetch: () => new Response("memory"),
    };
    const createDashboardApp = vi.fn(
      (options: {
        pluginRoutes?: Array<{
          app: { fetch(request: Request): Promise<Response> | Response };
          pluginName: string;
        }>;
      }) => ({
        fetch(request: Request) {
          const pathname = new URL(request.url).pathname;
          const route = options.pluginRoutes?.find((candidate) =>
            pathname.startsWith(`/api/plugins/${candidate.pluginName}`),
          );
          return route?.app.fetch(request) ?? new Response("dashboard");
        },
      }),
    );
    vi.doMock("#junior/config", () => ({
      createDashboardApp,
      dashboard: {
        authRequired: false,
        allowedGoogleDomains: ["sentry.io"],
      },
      pluginSet: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "memory",
            displayName: "Memory",
            description: "Memory plugin",
          },
          hooks: {
            apiRoutes() {
              return pluginRouteApp;
            },
          },
        }),
      ]),
      plugins: undefined,
      pluginRuntimeRegistrations: ["memory"],
    }));

    const app = await createApp();

    const response = await app.fetch(
      new Request("http://localhost/api/plugins/memory"),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("memory");

    const peoplePage = await app.fetch(new Request("http://localhost/people"));
    expect(peoplePage.status).toBe(200);
    await expect(peoplePage.text()).resolves.toBe("dashboard");

    const systemPage = await app.fetch(new Request("http://localhost/system"));
    expect(systemPage.status).toBe(200);
    await expect(systemPage.text()).resolves.toBe("dashboard");

    const dashboardAvatar = await app.fetch(
      new Request("http://localhost/_junior/dashboard/avatar.png"),
    );
    expect(dashboardAvatar.status).toBe(200);
    await expect(dashboardAvatar.text()).resolves.toBe("dashboard");

    const pluginsPage = await app.fetch(
      new Request("http://localhost/plugins"),
    );
    expect(pluginsPage.status).toBe(404);

    const peopleApi = await app.fetch(
      new Request("http://localhost/api/people"),
    );
    expect(peopleApi.status).toBe(200);
    await expect(peopleApi.text()).resolves.toBe("dashboard");
  });

  it("rejects app-level plugin routes that conflict with core dashboard routes", async () => {
    for (const path of [
      "/api/plugins/*",
      "/api/conversations/*",
      "/api/locations/*",
      "/api/people/*",
      "/conversations/*",
      "/locations/*",
      "/people/*",
      "/system",
      "/*",
      "/api/*",
      "/:slug",
      "/api/:section/*",
    ]) {
      await expect(
        createApp({
          dashboard: {
            authRequired: false,
            allowedGoogleDomains: ["sentry.io"],
          },
          plugins: defineJuniorPlugins([
            defineJuniorPlugin({
              manifest: {
                name: "legacy-dashboard",
                displayName: "Legacy Dashboard",
                description: "Legacy dashboard route plugin",
              },
              hooks: {
                routes() {
                  return [
                    {
                      path,
                      handler: () => new Response("legacy"),
                    },
                  ];
                },
              },
            }),
          ]),
        }),
      ).rejects.toThrow(
        `Plugin "legacy-dashboard" route "${path}" conflicts with core dashboard routes`,
      );
    }
  });

  it("configures Slack footer links from core dashboard options", async () => {
    vi.doMock("#junior/config", () => ({
      createDashboardApp: vi.fn((_options: unknown) => ({
        fetch: () => new Response("dashboard"),
      })),
      dashboard: undefined,
      pluginSet: defineJuniorPlugins([]),
      plugins: undefined,
      pluginRuntimeRegistrations: [],
    }));

    await createApp({
      dashboard: {
        allowedGoogleDomains: ["sentry.io"],
        authRequired: false,
        basePath: "/ops",
        baseURL: "https://junior.example.com",
      },
      plugins: defineJuniorPlugins([]),
    });

    expect(
      buildSlackReplyFooter({
        conversationId: "slack:C123:1700000000.000100",
      }),
    ).toEqual({
      items: [
        {
          label: "ID",
          url: "https://junior.example.com/ops/conversations/slack%3AC123%3A1700000000.000100",
          value: "slack:C123:1700000000.000100",
        },
      ],
    });
  });
});
