import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { juniorVercelConfig, writeVercelJson } from "@/vercel";

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

describe("juniorVercelConfig", () => {
  it("returns config with framework hono and default options", () => {
    const cwd = makeTempDir("junior-vercel-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"fixture"}\n');

    const config = juniorVercelConfig({ cwd });

    expect(config.framework).toBe("hono");
    expect(config.buildCommand).toBe("pnpm build");

    const fn = (config.functions as Record<string, Record<string, unknown>>)[
      "server.ts"
    ];
    expect(fn.maxDuration).toBe(800);
    expect(fn.includeFiles).toBe("./app/**/*");
  });

  it("includes discovered plugin assets in includeFiles as brace expansion", () => {
    const cwd = makeTempDir("junior-vercel-plugins-");
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

    const config = juniorVercelConfig({ cwd });
    const fn = (config.functions as Record<string, Record<string, unknown>>)[
      "server.ts"
    ];
    const includeFiles = fn.includeFiles as string;

    expect(includeFiles).toContain("./app/**/*");
    expect(includeFiles).toContain(
      "./node_modules/@sentry/junior-github/plugin.yaml",
    );
    expect(includeFiles).toContain(
      "./node_modules/@sentry/junior-github/skills/**/*",
    );
    expect(includeFiles).toMatch(/^\{.+\}$/);
  });

  it("respects custom entrypoint and maxDuration", () => {
    const cwd = makeTempDir("junior-vercel-opts-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"fixture"}\n');

    const config = juniorVercelConfig({
      cwd,
      entrypoint: "api/index.ts",
      maxDuration: 300,
    });

    const fn = (config.functions as Record<string, Record<string, unknown>>)[
      "api/index.ts"
    ];
    expect(fn.maxDuration).toBe(300);
  });

  it("omits buildCommand when set to null", () => {
    const cwd = makeTempDir("junior-vercel-nobuild-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"fixture"}\n');

    const config = juniorVercelConfig({ cwd, buildCommand: null });

    expect(config.buildCommand).toBeUndefined();
  });
});

describe("writeVercelJson", () => {
  it("writes vercel.json with discovered config", () => {
    const cwd = makeTempDir("junior-vercel-write-");
    fs.writeFileSync(path.join(cwd, "package.json"), '{"name":"fixture"}\n');

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

    writeVercelJson({ cwd });

    const written = JSON.parse(
      fs.readFileSync(path.join(cwd, "vercel.json"), "utf8"),
    );
    expect(written.framework).toBe("hono");
    const includeFiles = written.functions["server.ts"].includeFiles as string;
    expect(includeFiles).toContain(
      "./node_modules/@sentry/junior-github/plugin.yaml",
    );
  });
});
