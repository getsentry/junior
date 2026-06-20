import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCheck } from "@/cli/check";
import { runInit } from "@/cli/init";

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

describe("init cli", () => {
  it("writes the scaffold into an empty directory", async () => {
    const target = makeTempDir("junior-init-empty-");

    await runInit(target, () => undefined);

    expect(fs.existsSync(path.join(target, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "server.ts"))).toBe(true);
    expect(
      fs.existsSync(
        path.join(target, "api", "internal", "agent", "continue.ts"),
      ),
    ).toBe(true);
    expect(fs.existsSync(path.join(target, "vercel.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "nitro.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "plugins.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "vite.config.ts"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "WORLD.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "DESCRIPTION.md"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(target, ".github", "workflows", "ci.yml")),
    ).toBe(true);

    const workflow = fs.readFileSync(
      path.join(target, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("pnpm check");
    expect(workflow).toContain("pnpm build");
    expect(workflow).toContain("pnpm install --frozen-lockfile");

    const vercelConfig = JSON.parse(
      fs.readFileSync(path.join(target, "vercel.json"), "utf8"),
    );
    expect(vercelConfig.framework).toBe("nitro");
    expect(vercelConfig.buildCommand).toBe(
      "pnpm exec junior upgrade && pnpm build",
    );
    expect(vercelConfig.crons).toBeUndefined();
    expect(vercelConfig.functions).toBeUndefined();

    const nitroConfig = fs.readFileSync(
      path.join(target, "nitro.config.ts"),
      "utf8",
    );
    expect(nitroConfig).toContain(
      'import { juniorNitro } from "@sentry/junior/nitro";',
    );
    expect(nitroConfig).toContain("juniorNitro({");
    expect(nitroConfig).toContain('plugins: "./plugins"');

    const pluginsFile = fs.readFileSync(
      path.join(target, "plugins.ts"),
      "utf8",
    );
    expect(pluginsFile).toContain(
      'import { defineJuniorPlugins } from "@sentry/junior";',
    );
    expect(pluginsFile).toContain(
      'import { createMemoryPlugin } from "@sentry/junior-memory";',
    );
    expect(pluginsFile).toContain("defineJuniorPlugins(");
    expect(pluginsFile).toContain("createMemoryPlugin()");
    expect(pluginsFile).toContain('"@sentry/junior-maintenance"');

    const pkg = JSON.parse(
      fs.readFileSync(path.join(target, "package.json"), "utf8"),
    );
    expect(pkg.dependencies["@sentry/junior"]).toBe("latest");
    expect(pkg.dependencies["@sentry/junior-memory"]).toBe("latest");
    expect(pkg.dependencies["@sentry/junior-maintenance"]).toBe("latest");
    expect(pkg.devDependencies.nitro).toBeDefined();
    expect(pkg.devDependencies.vite).toBeDefined();
    expect(pkg.devDependencies.vercel).toBeUndefined();
    expect(pkg.scripts.dev).toBe("vite dev");
    expect(pkg.scripts.check).toBe("junior check");
    expect(pkg.scripts.build).toBe("junior snapshot create && vite build");

    const envExample = fs.readFileSync(
      path.join(target, ".env.example"),
      "utf8",
    );
    expect(envExample).toContain("CRON_SECRET=");
    expect(envExample).toContain("JUNIOR_SLASH_COMMAND=");

    const checkLines: string[] = [];
    await runCheck(target, {
      info: (line) => checkLines.push(line),
      warn: (line) => checkLines.push(line),
      error: (line) => checkLines.push(line),
    });
    expect(checkLines).toContain("✓ deployment config");
  });

  it("refuses to initialize a non-empty directory", async () => {
    const target = makeTempDir("junior-init-non-empty-");
    fs.writeFileSync(path.join(target, "README.md"), "# existing\n");

    await expect(runInit(target, () => undefined)).rejects.toThrow(
      "refusing to initialize non-empty directory",
    );
  });

  it("refuses to initialize a file path", async () => {
    const targetRoot = makeTempDir("junior-init-file-path-");
    const filePath = path.join(targetRoot, "not-a-dir.txt");
    fs.writeFileSync(filePath, "hello");

    await expect(runInit(filePath, () => undefined)).rejects.toThrow(
      "refusing to initialize non-directory path",
    );
  });
});
