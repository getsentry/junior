import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it } from "vitest";
import { juniorNitro } from "@/nitro";
import { defineJuniorPlugins } from "@/plugins";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-nitro-plugin-module-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("juniorNitro plugin modules", () => {
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
