import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONVERSATION_WORK_QUEUE_TOPIC } from "@/chat/task-execution/vercel-queue";
import {
  JUNIOR_CONVERSATION_WORK_CALLBACK_ROUTE,
  JUNIOR_HEARTBEAT_CRON_SCHEDULE,
  JUNIOR_HEARTBEAT_ROUTE,
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
          },
        },
        virtual,
      },
    };

    juniorNitro({ conversationWorkQueueTopic: "new_topic" }).nitro.setup(nitro);
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

  it("rejects direct trusted plugin sets because hooks need a runtime import", () => {
    const compiledHooks: Array<() => Promise<void> | void> = [];
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook(name: string, callback: () => Promise<void> | void) {
          if (name === "compiled") {
            compiledHooks.push(callback);
          }
        },
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
            name: "trusted",
            manifest: {
              name: "trusted",
              description: "Trusted plugin",
            },
            hooks: {},
          }),
        ]),
      }).nitro.setup(nitro),
    ).toThrow(
      'juniorNitro({ plugins }) cannot receive a direct defineJuniorPlugins(...) set with trusted plugin registration(s): trusted. Export the set from a runtime-safe plugin module and pass juniorNitro({ plugins: "./plugins" }) so createApp() can import the same hooks at runtime.',
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

    const compiledHooks: Array<() => Promise<void> | void> = [];
    const virtual: Record<string, (() => Promise<string>) | string> = {};
    const nitro = {
      hooks: {
        hook(name: string, callback: () => Promise<void> | void) {
          if (name === "compiled") {
            compiledHooks.push(callback);
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
    expect(compiledHooks).toHaveLength(1);
  });
});
