import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { juniorNitroConfig } from "@/nitro";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("juniorNitroConfig", () => {
  it("registers a compiled hook that copies app and packaged plugin assets", () => {
    const cwd = makeTempDir("junior-nitro-");

    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"fixture"}\n');
    fs.mkdirSync(path.join(cwd, "app"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "app", "SOUL.md"), "# Soul\n");

    const pluginRoot = path.join(
      cwd,
      "node_modules",
      "@sentry",
      "junior-github",
    );
    fs.mkdirSync(path.join(pluginRoot, "skills"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "plugin.yaml"), "name: github\n");
    fs.writeFileSync(
      path.join(pluginRoot, "skills", "SKILL.md"),
      "# GitHub Skill\n",
    );

    const config = juniorNitroConfig({ cwd });
    const serverRoot = path.join(
      cwd,
      ".vercel",
      "output",
      "functions",
      "__server.func",
    );
    const hooks = new Map<string, () => void>();

    config.modules[0].setup({
      hooks: {
        hook(name, callback) {
          hooks.set(name, callback);
        },
      },
      options: {
        output: {
          serverDir: serverRoot,
        },
      },
    });

    expect(hooks.has("compiled")).toBe(true);
    hooks.get("compiled")?.();

    expect(fs.existsSync(path.join(serverRoot, "app", "SOUL.md"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          serverRoot,
          "node_modules",
          "@sentry",
          "junior-github",
          "plugin.yaml",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          serverRoot,
          "node_modules",
          "@sentry",
          "junior-github",
          "skills",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
  });
});
