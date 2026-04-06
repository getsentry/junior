import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const originalCwd = process.cwd();
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const exampleRoot = path.join(repoRoot, "apps/example");
const exampleEntry = path.join(exampleRoot, "server.ts");

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
    JUNIOR_SKIP_SNAPSHOT: "1",
  };
  delete env.JUNIOR_EXTRA_PLUGIN_ROOTS;
  delete env.SKILL_DIRS;

  execFileSync("pnpm", ["--filter", "@sentry/junior", "build"], {
    cwd: repoRoot,
    env,
    stdio: "pipe",
  });

  // Re-sync pnpm store so the example app's node_modules/@sentry/junior
  // points to the freshly built dist, not a stale hardlink.
  execFileSync("pnpm", ["install"], {
    cwd: repoRoot,
    env,
    stdio: "pipe",
  });
}

async function importExampleApp() {
  const href = `${pathToFileURL(exampleEntry).href}?t=${Date.now()}`;
  return (await import(href)).default as {
    fetch: (request: Request) => Promise<Response>;
  };
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

  it("reports discovery state from the example app", async () => {
    const packageNames = getExamplePluginPackages();
    process.chdir(exampleRoot);
    process.env.JUNIOR_PLUGIN_PACKAGES = JSON.stringify(packageNames);

    const app = await importExampleApp();
    const response = await app.fetch(new Request("http://localhost/api/info"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      aboutText?: string;
      homeDir: string;
      packagedContent: {
        packageNames: string[];
        manifestRoots: string[];
        skillRoots: string[];
      };
      providers: string[];
      skills: Array<{ name: string }>;
    };

    expect(body.aboutText).toBe(
      "Junior helps your team make progress directly in Slack.",
    );
    expect(body.homeDir).toBe(path.join(exampleRoot, "app"));
    expect(body.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(["example-local", "example-bundle-help"]),
    );
    expect(body.providers).toEqual(
      expect.arrayContaining([
        "agent-browser",
        "example-bundle",
        "github",
        "notion",
        "sentry",
      ]),
    );
    expect(body.packagedContent.packageNames).toEqual(
      expect.arrayContaining(packageNames),
    );
    expect(body.packagedContent.manifestRoots).toEqual(
      expect.arrayContaining(
        packageNames.map((packageName) =>
          path.join(exampleRoot, "node_modules", ...packageName.split("/")),
        ),
      ),
    );
    expect(body.packagedContent.skillRoots).toEqual(
      expect.arrayContaining(
        packageNames.map((packageName) =>
          path.join(
            exampleRoot,
            "node_modules",
            ...packageName.split("/"),
            "skills",
          ),
        ),
      ),
    );
  }, 15_000);
});
