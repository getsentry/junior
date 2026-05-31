import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleRoot = path.join(repoRoot, "apps/example");
const exampleEntry = path.join(exampleRoot, "server.ts");
const exampleNitroConfig = path.join(exampleRoot, "nitro.config.ts");
const exampleRequire = createRequire(exampleEntry);
const vercelEnvNames = [
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
];

function isSamePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function getExamplePluginPackages(): string[] {
  const pkg = JSON.parse(
    readFileSync(path.join(exampleRoot, "package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
  };

  return Object.keys(pkg.dependencies ?? {}).filter(
    (name) => name.startsWith("@sentry/junior-") && name !== "@sentry/junior",
  );
}

function buildJuniorPackage(): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "true",
    JUNIOR_SKIP_SNAPSHOT: "1",
  };
  delete env.SKILL_DIRS;

  execFileSync("pnpm", ["--filter", "@sentry/junior", "build"], {
    cwd: repoRoot,
    env,
    stdio: "pipe",
  });

  const installedPackageRoot = path.dirname(
    path.dirname(exampleRequire.resolve("@sentry/junior")),
  );
  const sourceDist = path.join(repoRoot, "packages/junior/dist");
  const installedDist = path.join(installedPackageRoot, "dist");
  if (isSamePath(installedDist, sourceDist)) {
    return;
  }

  rmSync(installedDist, {
    force: true,
    recursive: true,
  });
  cpSync(sourceDist, installedDist, { recursive: true });
}

async function importExampleApp() {
  const href = `${pathToFileURL(exampleEntry).href}?t=${Date.now()}`;
  return (await import(href)).default as {
    fetch: (request: Request) => Promise<Response>;
  };
}

async function importExampleNitroConfig() {
  const href = `${pathToFileURL(exampleNitroConfig).href}?t=${Date.now()}`;
  return (await import(href)) as {
    exampleDashboardAuthRequired: () => boolean;
  };
}

function clearVercelEnv(): void {
  for (const name of vercelEnvNames) {
    delete process.env[name];
  }
}

describe.sequential("example build discovery integration", () => {
  beforeAll(() => {
    buildJuniorPackage();
  }, 60_000);

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("only disables dashboard auth for local development outside Vercel", async () => {
    const config = await importExampleNitroConfig();

    process.env = { ...originalEnv, NODE_ENV: "development" };
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(false);

    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      VERCEL: "1",
    };
    expect(config.exampleDashboardAuthRequired()).toBe(true);

    process.env = { ...originalEnv, NODE_ENV: "production" };
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(true);

    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(true);
  });

  it("serves built health and recognizes the sentry oauth callback route", async () => {
    process.chdir(exampleRoot);
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(
      getExamplePluginPackages(),
    );

    const app = await importExampleApp();

    const health = await app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      status: "ok",
      service: "junior",
    });

    const oauth = await app.fetch(
      new Request("http://localhost/api/oauth/callback/sentry"),
    );
    expect(oauth.status).toBe(400);
    expect(await oauth.text()).toContain("missing required parameters");
  }, 15_000);

  it("does not expose discovery state from the public example app", async () => {
    const packageNames = getExamplePluginPackages();
    process.chdir(exampleRoot);
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(packageNames);

    const app = await importExampleApp();
    const response = await app.fetch(new Request("http://localhost/api/info"));

    expect(response.status).toBe(404);
  }, 15_000);
});
