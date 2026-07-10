import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleRoot = path.join(repoRoot, "apps/example");
const exampleEntry = path.join(exampleRoot, "server.ts");
const examplePluginsModule = path.join(exampleRoot, "plugins.ts");
const exampleDashboardConfig = path.join(exampleRoot, "dashboard.ts");
const examplePackageJson = path.join(exampleRoot, "package.json");
const exampleRequire = createRequire(exampleEntry);
const exampleDatabaseUrl = "postgres://configured.example.test/neon";
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

async function getExamplePluginPackages(): Promise<string[]> {
  const href = `${pathToFileURL(examplePluginsModule).href}?t=${Date.now()}`;
  const { plugins } = (await import(href)) as {
    plugins: {
      packageNames: string[];
      registrations: Array<{ packageName?: string }>;
    };
  };

  return [
    ...plugins.packageNames,
    ...plugins.registrations.flatMap((plugin) =>
      plugin.packageName ? [plugin.packageName] : [],
    ),
  ];
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

async function importExampleDashboardConfig() {
  const href = `${pathToFileURL(exampleDashboardConfig).href}?t=${Date.now()}`;
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

  beforeEach(() => {
    process.env.DATABASE_URL ??= exampleDatabaseUrl;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  it("only disables dashboard auth for local development outside Vercel", async () => {
    const config = await importExampleDashboardConfig();

    process.env = { ...originalEnv, NODE_ENV: "development" };
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(false);

    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      VERCEL: "1",
    };
    expect(config.exampleDashboardAuthRequired()).toBe(true);

    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      VERCEL: "1",
      VERCEL_ENV: "development",
    };
    expect(config.exampleDashboardAuthRequired()).toBe(false);

    process.env = {
      ...originalEnv,
      JUNIOR_DASHBOARD_AUTH_REQUIRED: "false",
    };
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(false);

    process.env = {
      ...originalEnv,
      JUNIOR_DASHBOARD_AUTH_REQUIRED: "false",
      VERCEL: "1",
    };
    expect(config.exampleDashboardAuthRequired()).toBe(true);

    process.env = {
      ...originalEnv,
      NODE_ENV: "development",
      JUNIOR_DASHBOARD_AUTH_REQUIRED: "true",
    };
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(true);

    process.env = { ...originalEnv, NODE_ENV: "production" };
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(true);

    process.env = { ...originalEnv };
    delete process.env.NODE_ENV;
    clearVercelEnv();
    expect(config.exampleDashboardAuthRequired()).toBe(true);
  });

  it("does not include top-level Vercel api source files", () => {
    expect(existsSync(path.join(exampleRoot, "api"))).toBe(false);
  });

  it("runs deployment build guards around the Vercel app build", () => {
    const packageJson = JSON.parse(
      readFileSync(examplePackageJson, "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.prebuild).toContain(
      "pnpm --filter @sentry/junior build",
    );
    expect(packageJson.scripts?.prebuild).toContain(
      "pnpm --filter @sentry/junior-dashboard build",
    );
    expect(packageJson.scripts?.prebuild).toContain(
      "pnpm --filter @sentry/junior-scheduler build",
    );
    expect(packageJson.scripts?.postbuild).toBe(
      "node scripts/check-vercel-output.mjs",
    );
  });

  it("serves built health and recognizes the sentry oauth callback route", async () => {
    process.chdir(exampleRoot);
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(
      await getExamplePluginPackages(),
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

  it("routes the queue consumer endpoint through the app", async () => {
    process.chdir(exampleRoot);
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(
      await getExamplePluginPackages(),
    );

    const app = await importExampleApp();
    const response = await app.fetch(
      new Request("http://localhost/api/internal/agent/continue", {
        method: "POST",
        body: "{}",
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Invalid content type");
  }, 15_000);

  it("does not expose discovery state from the public example app", async () => {
    const packageNames = await getExamplePluginPackages();
    process.chdir(exampleRoot);
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(packageNames);

    const app = await importExampleApp();
    const response = await app.fetch(new Request("http://localhost/api/info"));

    expect(response.status).toBe(404);
  }, 15_000);
});
