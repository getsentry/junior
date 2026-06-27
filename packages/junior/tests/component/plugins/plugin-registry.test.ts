import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/discovery");
  vi.doUnmock("@/chat/plugins/package-discovery");
});

describe("plugin registry", () => {
  it("is empty when no local or installed plugin packages are present", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-empty-"),
    );
    process.chdir(tempRoot);

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: [],
        packages: [],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");

    expect(registry.getPluginProviders()).toEqual([]);
    expect(registry.getPluginCapabilityProviders()).toEqual([]);
    expect(registry.getPluginSkillRoots()).toEqual([]);
    expect(registry.getPluginOAuthConfig("unknown")).toBeUndefined();
    expect(registry.isPluginProvider("sentry")).toBe(false);
    expect(registry.isPluginCapability("sentry.api")).toBe(false);
    expect(registry.isPluginConfigKey("sentry.org")).toBe(false);
    expect(() =>
      registry.createPluginBroker("sentry", {
        userTokenStore: {
          get: async () => undefined,
          set: async () => {},
          delete: async () => {},
          withRefresh: async (_userId, _provider, callback) => callback(),
        },
      }),
    ).toThrow('Unknown plugin provider: "sentry"');
  });

  it("reloads plugin state after packaged content changes", async () => {
    const packagedContent = {
      packageNames: [] as string[],
      packages: [] as {
        dir: string;
        hasMigrationsDir: boolean;
        hasSkillsDir: boolean;
        packageName: string;
      }[],
      manifestRoots: [] as string[],
      skillRoots: [] as string[],
      tracingIncludes: [] as string[],
    };

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => packagedContent,
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");
    expect(registry.getPluginProviders()).toEqual([]);

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-reload-"),
    );
    const pluginRoot = path.join(tempRoot, "demo-plugin");
    const skillsRoot = path.join(pluginRoot, "skills");
    await fs.mkdir(skillsRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "plugin.yaml"),
      ["name: demo", "display-name: Demo", "description: Demo plugin"].join(
        "\n",
      ),
      "utf8",
    );

    packagedContent.packageNames = ["@acme/demo-plugin"];
    packagedContent.manifestRoots = [pluginRoot];
    packagedContent.skillRoots = [skillsRoot];

    expect(registry.getPluginProviders()).toHaveLength(1);
    expect(registry.getPluginProviders()[0]?.manifest.name).toBe("demo");
    expect(registry.getPluginSkillRoots()).toContain(skillsRoot);
    expect(registry.isPluginProvider("demo")).toBe(true);
  });

  it("does not register migrations from plugin yaml packages", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-yaml-migrations-"),
    );
    const pluginRoot = path.join(tempRoot, "demo-plugin");
    const migrationsRoot = path.join(pluginRoot, "migrations");
    await fs.mkdir(migrationsRoot, { recursive: true });
    await fs.writeFile(
      path.join(pluginRoot, "plugin.yaml"),
      ["name: demo", "display-name: Demo", "description: Demo plugin"].join(
        "\n",
      ),
      "utf8",
    );
    await fs.writeFile(
      path.join(migrationsRoot, "0001_init.sql"),
      "CREATE TABLE junior_demo_records (id text PRIMARY KEY);",
      "utf8",
    );

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: ["@acme/demo-plugin"],
        packages: [
          {
            dir: pluginRoot,
            hasMigrationsDir: true,
            hasSkillsDir: false,
            packageName: "@acme/demo-plugin",
          },
        ],
        manifestRoots: [pluginRoot],
        skillRoots: [],
        tracingIncludes: [],
      }),
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");

    expect(registry.getPluginProviders()).toHaveLength(1);
    expect(registry.getPluginProviders()[0]?.manifest.name).toBe("demo");
    expect(registry.getPluginMigrationRoots()).toEqual([]);
  });

  it("ignores package migrations without inline code registrations", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-unowned-migrations-"),
    );
    const pluginRoot = path.join(tempRoot, "code-plugin");
    await fs.mkdir(path.join(pluginRoot, "migrations"), { recursive: true });

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: ["@acme/code-plugin"],
        packages: [
          {
            dir: pluginRoot,
            hasMigrationsDir: true,
            hasSkillsDir: false,
            packageName: "@acme/code-plugin",
          },
        ],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");
    registry.setPluginCatalogConfig({
      packages: ["@acme/code-plugin"],
    });

    expect(registry.getPluginMigrationRoots()).toEqual([]);
  });

  it("registers named migrations from inline code plugin packages", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-code-migrations-"),
    );
    const pluginRoot = path.join(tempRoot, "code-plugin");
    const migrationsRoot = path.join(pluginRoot, "migrations");
    await fs.mkdir(migrationsRoot, { recursive: true });
    await fs.writeFile(
      path.join(migrationsRoot, "0001_init.sql"),
      "CREATE TABLE junior_code_plugin_records (id text PRIMARY KEY);",
      "utf8",
    );

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: ["@acme/code-plugin"],
        packages: [
          {
            dir: pluginRoot,
            hasMigrationsDir: true,
            hasSkillsDir: false,
            packageName: "@acme/code-plugin",
          },
        ],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");
    registry.setPluginCatalogConfig({
      packages: ["@acme/code-plugin"],
      inlineManifests: [
        {
          packageName: "@acme/code-plugin",
          manifest: {
            name: "code-plugin",
            displayName: "Code Plugin",
            description: "Code plugin",
            capabilities: [],
            configKeys: [],
          },
        },
      ],
    });

    expect(registry.getPluginMigrationRoots()).toEqual([
      { pluginName: "code-plugin", dir: migrationsRoot },
    ]);
  });

  it("reloads inline migration roots when package metadata changes", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-migration-reload-"),
    );
    const pluginRoot = path.join(tempRoot, "code-plugin");
    const migrationsRoot = path.join(pluginRoot, "migrations");
    await fs.mkdir(pluginRoot, { recursive: true });

    const packagedContent = {
      packageNames: ["@acme/code-plugin"],
      packages: [
        {
          dir: pluginRoot,
          hasMigrationsDir: false,
          hasSkillsDir: false,
          packageName: "@acme/code-plugin",
        },
      ],
      manifestRoots: [] as string[],
      skillRoots: [] as string[],
      tracingIncludes: [] as string[],
    };

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => packagedContent,
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");
    registry.setPluginCatalogConfig({
      packages: ["@acme/code-plugin"],
      inlineManifests: [
        {
          packageName: "@acme/code-plugin",
          manifest: {
            name: "code-plugin",
            displayName: "Code Plugin",
            description: "Code plugin",
            capabilities: [],
            configKeys: [],
          },
        },
      ],
    });

    expect(registry.getPluginMigrationRoots()).toEqual([]);

    await fs.mkdir(migrationsRoot);
    packagedContent.packages[0]!.hasMigrationsDir = true;

    expect(registry.getPluginMigrationRoots()).toEqual([
      { pluginName: "code-plugin", dir: migrationsRoot },
    ]);
  });

  it("rejects shared package migrations across inline registrations", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-shared-migrations-"),
    );
    const pluginRoot = path.join(tempRoot, "code-plugin");
    await fs.mkdir(path.join(pluginRoot, "migrations"), { recursive: true });

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: ["@acme/code-plugin"],
        packages: [
          {
            dir: pluginRoot,
            hasMigrationsDir: true,
            hasSkillsDir: false,
            packageName: "@acme/code-plugin",
          },
        ],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");
    registry.setPluginCatalogConfig({
      packages: ["@acme/code-plugin"],
      inlineManifests: [
        {
          packageName: "@acme/code-plugin",
          manifest: {
            name: "code-plugin",
            displayName: "Code Plugin",
            description: "Code plugin",
            capabilities: [],
            configKeys: [],
          },
        },
        {
          packageName: "@acme/code-plugin",
          manifest: {
            name: "other-plugin",
            displayName: "Other Plugin",
            description: "Other plugin",
            capabilities: [],
            configKeys: [],
          },
        },
      ],
    });

    expect(() => registry.getPluginMigrationRoots()).toThrow(
      'Plugin "other-plugin" cannot share migrations directory with plugin "code-plugin"',
    );
  });

  it("does not register a skillsDir for local yaml plugins that have no skills directory", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-no-skills-"),
    );
    // Create a plugin directory with a plugin.yaml but no skills/ subdirectory
    const pluginDir = path.join(tempRoot, "rust-toolchain");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "plugin.yaml"),
      [
        "name: rust-toolchain",
        "display-name: Rust Toolchain",
        "description: Rust toolchain plugin",
      ].join("\n"),
      "utf8",
    );

    vi.doMock("@/chat/discovery", () => ({
      pluginRoots: () => [tempRoot],
    }));
    vi.doMock("@/chat/plugins/package-discovery", () => ({
      discoverInstalledPluginPackageContent: () => ({
        packageNames: [],
        packages: [],
        manifestRoots: [],
        skillRoots: [],
        tracingIncludes: [],
      }),
      normalizePluginPackageNames: (names: string[] | undefined) => names,
    }));

    const registry = await import("@/chat/plugins/registry");

    expect(registry.getPluginProviders()).toHaveLength(1);
    expect(registry.getPluginProviders()[0]?.manifest.name).toBe(
      "rust-toolchain",
    );
    // No skills directory exists, so the plugin must not contribute a skill root
    expect(registry.getPluginSkillRoots()).toEqual([]);
  });
});
