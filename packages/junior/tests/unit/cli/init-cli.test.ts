import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(fs.existsSync(path.join(target, "vercel.json"))).toBe(true);
    expect(fs.existsSync(path.join(target, "nitro.config.ts"))).toBe(false);
    expect(fs.existsSync(path.join(target, "vite.config.ts"))).toBe(false);
    expect(fs.existsSync(path.join(target, "app", "SOUL.md"))).toBe(true);
    expect(fs.existsSync(path.join(target, "app", "ABOUT.md"))).toBe(true);

    const vercelConfig = JSON.parse(
      fs.readFileSync(path.join(target, "vercel.json"), "utf8"),
    );
    expect(vercelConfig.framework).toBe("hono");
    expect(vercelConfig.buildCommand).toBe("pnpm build");
    expect(vercelConfig.functions["server.ts"].maxDuration).toBe(800);
    expect(vercelConfig.functions["server.ts"].includeFiles).toBe(
      "{./app/**,./node_modules/@sentry/junior*/**}",
    );

    const pkg = JSON.parse(
      fs.readFileSync(path.join(target, "package.json"), "utf8"),
    );
    expect(pkg.devDependencies.vercel).toBeDefined();
    expect(pkg.devDependencies.nitro).toBeUndefined();
    expect(pkg.devDependencies.vite).toBeUndefined();
    expect(pkg.scripts.dev).toBeUndefined();
    expect(pkg.scripts.build).toBe("junior snapshot create");
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
