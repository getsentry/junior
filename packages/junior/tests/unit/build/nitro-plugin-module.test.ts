import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { PLUGIN_TASK_QUEUE_TOPIC } from "@/chat/plugins/task-queue";
import { DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC } from "@/chat/task-execution/vercel-queue";
import {
  JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
  JUNIOR_HEARTBEAT_CRON_SCHEDULE,
  JUNIOR_HEARTBEAT_ROUTE,
  JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE,
  JUNIOR_RETENTION_CRON_SCHEDULE,
  JUNIOR_RETENTION_ROUTE,
} from "@/deployment";
import { juniorNitro } from "@/nitro";
import { defineJuniorPlugins } from "@/plugins";

const tempDirs: string[] = [];

interface TestFunctionRule {
  maxDuration?: number | "max";
  memory?: number;
  experimentalTriggers?: Array<{
    type: string;
    topic: string;
    consumer?: string;
  }>;
}

interface TestVercelOptions {
  config?: {
    version: 3;
    crons?: Array<{ path: string; schedule: string }>;
  };
  functions?: Record<string, unknown>;
  functionRules?: Record<string, TestFunctionRule>;
}

interface TestBuildPlugin {
  name: string;
  writeBundle?: () => Promise<void> | void;
}

interface TestBuildConfig {
  plugins?: TestBuildPlugin[];
}

type TestRollupBeforeHook = (
  nitro: unknown,
  config: TestBuildConfig,
) => Promise<void> | void;

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-nitro-plugin-module-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

function getVercelOptions(nitro: {
  options: { vercel: unknown };
}): TestVercelOptions {
  return nitro.options.vercel as TestVercelOptions;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("juniorNitro plugin modules", () => {
  it("configures Vercel build output for heartbeat and conversation work", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {},
        virtual,
      },
    };

    juniorNitro().nitro.setup(nitro);
    const vercel = getVercelOptions(nitro);

    expect(vercel.config).toEqual({
      version: 3,
      crons: [
        {
          path: JUNIOR_HEARTBEAT_ROUTE,
          schedule: JUNIOR_HEARTBEAT_CRON_SCHEDULE,
        },
        {
          path: JUNIOR_RETENTION_ROUTE,
          schedule: JUNIOR_RETENTION_CRON_SCHEDULE,
        },
      ],
    });
    expect(vercel.functions).toEqual({
      maxDuration: 300,
    });
    expect(
      vercel.functionRules?.[JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE],
    ).toEqual({
      maxDuration: 300,
      experimentalTriggers: [
        {
          type: "queue/v2beta",
          topic: DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC,
        },
      ],
    });
    expect(vercel.functionRules?.[JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE]).toEqual({
      maxDuration: 300,
      experimentalTriggers: [
        {
          type: "queue/v2beta",
          topic: PLUGIN_TASK_QUEUE_TOPIC,
        },
      ],
    });
  });

  it("preserves existing Vercel route function settings", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {
          config: {
            version: 3,
            crons: [
              {
                path: JUNIOR_HEARTBEAT_ROUTE,
                schedule: "*/5 * * * *",
              },
            ],
          },
          functions: {
            maxDuration: 120,
            memory: 1024,
          },
          functionRules: {
            [JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE]: {
              memory: 2048,
              experimentalTriggers: [
                {
                  type: "queue/v2beta",
                  topic: DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC,
                },
              ],
            },
            [JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE]: {
              memory: 1024,
              experimentalTriggers: [
                {
                  type: "queue/v2beta",
                  topic: PLUGIN_TASK_QUEUE_TOPIC,
                },
              ],
            },
          },
        },
        virtual,
      },
    };

    juniorNitro({ maxDuration: 300 }).nitro.setup(nitro);
    const vercel = getVercelOptions(nitro);

    expect(vercel.config?.crons).toEqual([
      {
        path: JUNIOR_HEARTBEAT_ROUTE,
        schedule: "*/5 * * * *",
      },
      {
        path: JUNIOR_RETENTION_ROUTE,
        schedule: JUNIOR_RETENTION_CRON_SCHEDULE,
      },
    ]);
    expect(vercel.functions).toEqual({
      maxDuration: 120,
      memory: 1024,
    });
    expect(
      vercel.functionRules?.[JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE],
    ).toEqual({
      maxDuration: 120,
      memory: 2048,
      experimentalTriggers: [
        {
          type: "queue/v2beta",
          topic: DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC,
        },
      ],
    });
    expect(vercel.functionRules?.[JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE]).toEqual({
      maxDuration: 120,
      memory: 1024,
      experimentalTriggers: [
        {
          type: "queue/v2beta",
          topic: PLUGIN_TASK_QUEUE_TOPIC,
        },
      ],
    });
  });

  it("uses a custom Vercel conversation work queue topic", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {},
        virtual,
      },
    };

    juniorNitro({ conversationWorkQueueTopic: "custom_work" }).nitro.setup(
      nitro,
    );
    const vercel = getVercelOptions(nitro);

    expect(
      vercel.functionRules?.[JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE]
        ?.experimentalTriggers,
    ).toEqual([
      {
        type: "queue/v2beta",
        topic: "custom_work",
      },
    ]);
  });

  it("replaces a stale queue trigger when the topic changes", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {
          functionRules: {
            [JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE]: {
              experimentalTriggers: [
                {
                  type: "queue/v2beta",
                  topic: "old_topic",
                },
              ],
            },
            [JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE]: {
              experimentalTriggers: [
                {
                  type: "queue/v2beta",
                  topic: "old_tasks",
                },
              ],
            },
          },
        },
        virtual,
      },
    };

    juniorNitro({
      conversationWorkQueueTopic: "new_topic",
    }).nitro.setup(nitro);
    const vercel = getVercelOptions(nitro);

    expect(
      vercel.functionRules?.[JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE]
        ?.experimentalTriggers,
    ).toEqual([
      {
        type: "queue/v2beta",
        topic: "new_topic",
      },
    ]);
    expect(
      vercel.functionRules?.[JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE]
        ?.experimentalTriggers,
    ).toEqual([
      {
        type: "queue/v2beta",
        topic: PLUGIN_TASK_QUEUE_TOPIC,
      },
    ]);
  });

  it("preserves Vercel max function duration settings", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {
          functions: {
            maxDuration: "max" as const,
          },
        },
        virtual,
      },
    };

    juniorNitro().nitro.setup(nitro);
    const vercel = getVercelOptions(nitro);

    expect(
      vercel.functionRules?.[JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE]
        ?.maxDuration,
    ).toBe("max");
    expect(
      vercel.functionRules?.[JUNIOR_PLUGIN_TASK_CALLBACK_ROUTE]?.maxDuration,
    ).toBe("max");
  });

  it("loads plugin modules lazily when virtual config is rendered", async () => {
    const tempRoot = await makeTempDir();
    await fs.writeFile(
      path.join(tempRoot, "plugins.mjs"),
      [
        "globalThis.__juniorNitroPluginModuleImports = (globalThis.__juniorNitroPluginModuleImports ?? 0) + 1;",
        "export const plugins = {",
        "  packageNames: [],",
        "  registrations: [],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const globalState = globalThis as typeof globalThis & {
      __juniorNitroPluginModuleImports?: number;
    };
    delete globalState.__juniorNitroPluginModuleImports;

    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: path.join(tempRoot, ".output", "server"),
        },
        rootDir: tempRoot,
        vercel: {},
        virtual,
      },
    };

    juniorNitro({ plugins: "./plugins" }).nitro.setup(nitro);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(globalState.__juniorNitroPluginModuleImports).toBeUndefined();

    const template = virtual["#junior/config"];
    expect(typeof template).toBe("function");
    await (template as () => Promise<string>)();

    expect(globalState.__juniorNitroPluginModuleImports).toBe(1);
    delete globalState.__juniorNitroPluginModuleImports;
  });

  it("copies dashboard assets when core dashboard config is enabled", async () => {
    const tempRoot = await makeTempDir();
    const dashboardDist = path.join(
      tempRoot,
      "node_modules",
      "@sentry",
      "junior-dashboard",
      "dist",
    );
    await fs.mkdir(dashboardDist, { recursive: true });
    await fs.writeFile(
      path.join(
        tempRoot,
        "node_modules",
        "@sentry",
        "junior-dashboard",
        "package.json",
      ),
      JSON.stringify({ name: "@sentry/junior-dashboard" }),
      "utf8",
    );
    await fs.writeFile(path.join(dashboardDist, "client.js"), "client", "utf8");
    await fs.writeFile(
      path.join(dashboardDist, "tailwind.css"),
      "tailwind",
      "utf8",
    );

    const rollupBeforeHooks: TestRollupBeforeHook[] = [];
    const buildPlugins: TestBuildPlugin[] = [];
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook(name: string, callback: TestRollupBeforeHook) {
          if (name === "rollup:before") {
            rollupBeforeHooks.push(callback);
          }
        },
      },
      options: {
        output: {
          serverDir: path.join(tempRoot, ".output", "server"),
        },
        rootDir: tempRoot,
        vercel: {},
        virtual,
      },
    };

    juniorNitro({
      dashboard: { allowedGoogleDomains: ["sentry.io"] },
    }).nitro.setup(nitro);

    expect(rollupBeforeHooks).toHaveLength(1);
    await rollupBeforeHooks[0]({}, { plugins: buildPlugins });
    expect(buildPlugins).toHaveLength(1);
    await buildPlugins[0]?.writeBundle?.();

    await expect(
      fs.readFile(
        path.join(
          tempRoot,
          ".output",
          "server",
          "node_modules",
          "@sentry",
          "junior-dashboard",
          "dist",
          "client.js",
        ),
        "utf8",
      ),
    ).resolves.toBe("client");
    await expect(
      fs.readFile(
        path.join(
          tempRoot,
          ".output",
          "server",
          "node_modules",
          "@sentry",
          "junior-dashboard",
          "dist",
          "tailwind.css",
        ),
        "utf8",
      ),
    ).resolves.toBe("tailwind");
  });

  it("rejects direct plugin sets with runtime code because they need a runtime import", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {},
        virtual,
      },
    };

    expect(() =>
      juniorNitro({
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
      }).nitro.setup(nitro),
    ).toThrow(
      'juniorNitro({ plugins }) cannot receive a direct defineJuniorPlugins(...) set with runtime plugin registration(s): hooked. Export the set from a runtime-safe plugin module and pass juniorNitro({ plugins: "./plugins" }) so createApp() can import the same registrations at runtime.',
    );
  });

  it("rejects direct plugin sets with tasks because tasks need a runtime import", () => {
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: "/tmp/junior-output",
        },
        rootDir: "/tmp/junior-app",
        vercel: {},
        virtual,
      },
    };

    expect(() =>
      juniorNitro({
        plugins: defineJuniorPlugins([
          defineJuniorPlugin({
            manifest: {
              name: "tasked",
              displayName: "Tasked",
              description: "Runtime plugin",
            },
            tasks: {
              processSession: {
                run() {},
              },
            },
          }),
        ]),
      }).nitro.setup(nitro),
    ).toThrow(
      'juniorNitro({ plugins }) cannot receive a direct defineJuniorPlugins(...) set with runtime plugin registration(s): tasked. Export the set from a runtime-safe plugin module and pass juniorNitro({ plugins: "./plugins" }) so createApp() can import the same registrations at runtime.',
    );
  });

  it("injects a runtime import for plugin module references", async () => {
    const tempRoot = await makeTempDir();
    await fs.writeFile(
      path.join(tempRoot, "plugins.mjs"),
      [
        "export const plugins = {",
        '  packageNames: ["@acme/junior-demo"],',
        "  registrations: [],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const rollupBeforeHooks: TestRollupBeforeHook[] = [];
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook(name: string, callback: TestRollupBeforeHook) {
          if (name === "rollup:before") {
            rollupBeforeHooks.push(callback);
          }
        },
      },
      options: {
        output: {
          serverDir: path.join(tempRoot, ".output", "server"),
        },
        rootDir: tempRoot,
        vercel: {},
        virtual,
      },
    };

    juniorNitro({ plugins: "./plugins" }).nitro.setup(nitro);

    const template = virtual["#junior/config"];
    expect(typeof template).toBe("function");
    const code = await (template as () => Promise<string>)();

    expect(code).toContain(
      `import { plugins as juniorRuntimePluginSet } from ${JSON.stringify(path.join(tempRoot, "plugins.mjs").split(path.sep).join("/"))};`,
    );
    expect(code).toContain(
      'export const plugins = {"packages":["@acme/junior-demo"]};',
    );
    expect(rollupBeforeHooks).toHaveLength(1);
  });

  it("resolves package plugin modules with custom exports", async () => {
    const tempRoot = await makeTempDir();
    const packageDir = path.join(
      tempRoot,
      "node_modules",
      "@acme",
      "junior-runtime",
    );
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "@acme/junior-runtime",
        type: "module",
        exports: "./index.mjs",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(packageDir, "index.mjs"),
      [
        "export const runtimePlugins = {",
        '  packageNames: ["@acme/junior-demo"],',
        "  registrations: [],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: path.join(tempRoot, ".output", "server"),
        },
        rootDir: tempRoot,
        vercel: {},
        virtual,
      },
    };

    juniorNitro({
      plugins: {
        module: "@acme/junior-runtime",
        exportName: "runtimePlugins",
      },
    }).nitro.setup(nitro);

    const template = virtual["#junior/config"];
    expect(typeof template).toBe("function");
    const code = await (template as () => Promise<string>)();
    expect(code).toContain(
      'import { runtimePlugins as juniorRuntimePluginSet } from "@acme/junior-runtime";',
    );
    expect(code).toContain(
      'export const plugins = {"packages":["@acme/junior-demo"]};',
    );
  });

  it("resolves default plugin module exports", async () => {
    const tempRoot = await makeTempDir();
    await fs.writeFile(
      path.join(tempRoot, "plugins.mjs"),
      [
        "export default {",
        '  packageNames: ["@acme/junior-default"],',
        "  registrations: [],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook() {},
      },
      options: {
        output: {
          serverDir: path.join(tempRoot, ".output", "server"),
        },
        rootDir: tempRoot,
        vercel: {},
        virtual,
      },
    };

    juniorNitro({
      plugins: {
        module: "./plugins",
        exportName: "default",
      },
    }).nitro.setup(nitro);

    const template = virtual["#junior/config"];
    expect(typeof template).toBe("function");
    const code = await (template as () => Promise<string>)();
    expect(code).toContain(
      `import juniorRuntimePluginSet from ${JSON.stringify(path.join(tempRoot, "plugins.mjs").split(path.sep).join("/"))};`,
    );
    expect(code).toContain(
      'export const plugins = {"packages":["@acme/junior-default"]};',
    );
  });

  it("copies app and plugin content before Vercel route functions are cloned", async () => {
    const tempRoot = await makeTempDir();
    const serverDir = path.join(
      tempRoot,
      ".vercel",
      "output",
      "functions",
      "__server.func",
    );
    const callbackDir = path.join(
      tempRoot,
      ".vercel",
      "output",
      "functions",
      "api",
      "internal",
      "agent",
      "continue.func",
    );
    const packageDir = path.join(
      tempRoot,
      "node_modules",
      "@acme",
      "junior-demo",
    );
    await fs.mkdir(path.join(tempRoot, "app"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "app", "SOUL.md"),
      "Local soul\n",
      "utf8",
    );
    await fs.mkdir(path.join(packageDir, "skills", "demo"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(packageDir, "plugin.yaml"),
      "name: demo\ndescription: Demo plugin\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(packageDir, "skills", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
      "utf8",
    );
    await fs.mkdir(serverDir, { recursive: true });

    const rollupBeforeHooks: TestRollupBeforeHook[] = [];
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook(name: string, callback: TestRollupBeforeHook) {
          if (name === "rollup:before") {
            rollupBeforeHooks.push(callback);
          }
        },
      },
      options: {
        output: {
          serverDir,
        },
        rootDir: tempRoot,
        vercel: {},
        virtual,
      },
    };

    juniorNitro({
      cwd: tempRoot,
      plugins: defineJuniorPlugins(["@acme/junior-demo"]),
    }).nitro.setup(nitro);
    const buildConfig: TestBuildConfig = { plugins: [] };
    await rollupBeforeHooks[0]?.(nitro, buildConfig);
    const copyPlugin = buildConfig.plugins?.find(
      (plugin) => plugin.name === "junior:copy-build-content",
    );
    expect(copyPlugin).toBeDefined();
    await copyPlugin?.writeBundle?.();

    await fs.cp(serverDir, callbackDir, { recursive: true });

    for (const functionDir of [serverDir, callbackDir]) {
      await expect(
        fs.readFile(path.join(functionDir, "app", "SOUL.md"), "utf8"),
      ).resolves.toBe("Local soul\n");
      await expect(
        fs.readFile(
          path.join(
            functionDir,
            "node_modules",
            "@acme",
            "junior-demo",
            "plugin.yaml",
          ),
          "utf8",
        ),
      ).resolves.toContain("name: demo");
      await expect(
        fs.readFile(
          path.join(
            functionDir,
            "node_modules",
            "@acme",
            "junior-demo",
            "skills",
            "demo",
            "SKILL.md",
          ),
          "utf8",
        ),
      ).resolves.toContain("description: Demo");
    }
  });
});
