import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { juniorNitro } from "@/nitro";

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
