import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";

async function writePluginPackage(
  nodeModulesRoot: string,
  packageName: string,
  options: { entryPoint?: boolean } = {},
): Promise<string> {
  const packageRoot = path.join(nodeModulesRoot, ...packageName.split("/"));
  await fs.mkdir(path.join(packageRoot, "skills", "demo"), { recursive: true });
  const entryPoint = options.entryPoint ?? true;
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      ...(entryPoint ? { main: "index.js" } : {}),
    }),
    "utf8",
  );
  if (entryPoint) {
    await fs.writeFile(
      path.join(packageRoot, "index.js"),
      "export {};\n",
      "utf8",
    );
  }
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    "name: demo\ndescription: demo\n",
    "utf8",
  );
  return packageRoot;
}

describe("plugin package discovery", () => {
  it("does not discover plugin content from node_modules without explicit packageNames", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const nodeModulesRoot = path.join(tempRoot, "node_modules");
    await writePluginPackage(nodeModulesRoot, "@acme/junior-plugin-demo");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(tempRoot);
    expect(discovered.packageNames).toEqual([]);
    expect(discovered.manifestRoots).toEqual([]);
    expect(discovered.skillRoots).toEqual([]);
  });

  it("discovers plugin content from node_modules with explicit packageNames", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const nodeModulesRoot = path.join(tempRoot, "node_modules");
    const packageRoot = await writePluginPackage(
      nodeModulesRoot,
      "@acme/junior-plugin-demo",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(tempRoot, {
      packageNames: ["@acme/junior-plugin-demo"],
    });
    expect(discovered.packageNames).toContain("@acme/junior-plugin-demo");
    expect(discovered.manifestRoots).toContain(packageRoot);
    expect(discovered.skillRoots).toContain(path.join(packageRoot, "skills"));
    expect(discovered.tracingIncludes).toContain(
      "./node_modules/@acme/junior-plugin-demo/plugin.yaml",
    );
    expect(discovered.tracingIncludes).toContain(
      "./node_modules/@acme/junior-plugin-demo/skills/**/*",
    );
  });

  it("fails when an explicit plugin package is not installed", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    await fs.mkdir(path.join(tempRoot, "node_modules"), { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    expect(() =>
      discoverInstalledPluginPackageContent(tempRoot, {
        packageNames: ["@acme/missing-plugin"],
      }),
    ).toThrow(
      'Plugin package "@acme/missing-plugin" was configured but could not be resolved from node_modules',
    );
  });

  it("reports configured package resolution errors when cwd has no package manifest", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );

    expect(() =>
      discoverInstalledPluginPackageContent(tempRoot, {
        packageNames: ["@acme/missing-plugin"],
      }),
    ).toThrow(
      'Plugin package "@acme/missing-plugin" was configured but could not be resolved',
    );
  });

  it("fails when an explicit plugin package is not a package name", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    expect(() =>
      discoverInstalledPluginPackageContent(tempRoot, {
        packageNames: ["../plugins"],
      }),
    ).toThrow("Plugin package names must be valid npm package names");
  });

  it("fails when an explicit scoped plugin package is malformed", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    expect(() =>
      discoverInstalledPluginPackageContent(tempRoot, {
        packageNames: ["@acme"],
      }),
    ).toThrow("Plugin package names must be valid npm package names");
  });

  it("fails when an explicit plugin package has no plugin content", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const packageRoot = path.join(
      tempRoot,
      "node_modules",
      "@acme",
      "not-a-plugin",
    );
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    expect(() =>
      discoverInstalledPluginPackageContent(tempRoot, {
        packageNames: ["@acme/not-a-plugin"],
      }),
    ).toThrow(
      'Plugin package "@acme/not-a-plugin" was configured but does not contain plugin content',
    );
  });

  it("keeps nearest node_modules package when duplicate package names exist", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const nearNodeModulesRoot = path.join(tempRoot, "near", "node_modules");
    const farNodeModulesRoot = path.join(tempRoot, "far", "node_modules");
    const nearPackageRoot = await writePluginPackage(
      nearNodeModulesRoot,
      "@acme/junior-plugin-demo",
    );
    await writePluginPackage(farNodeModulesRoot, "@acme/junior-plugin-demo");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(tempRoot, {
      nodeModulesDirs: [nearNodeModulesRoot, farNodeModulesRoot],
      packageNames: ["@acme/junior-plugin-demo"],
    });

    expect(discovered.packageNames).toContain("@acme/junior-plugin-demo");
    expect(discovered.manifestRoots).toContain(nearPackageRoot);
    expect(
      discovered.manifestRoots.some((candidate) =>
        candidate.startsWith(farNodeModulesRoot),
      ),
    ).toBe(false);
  });

  it("resolves explicit packageNames through node_modules symlinked packages", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const linkedPackageSource = path.join(
      tempRoot,
      "packages",
      "junior-plugin-link",
    );
    const linkedPackageInNodeModules = path.join(
      tempRoot,
      "node_modules",
      "@acme",
      "junior-plugin-link",
    );

    await fs.mkdir(path.join(linkedPackageSource, "skills", "demo"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(linkedPackageSource, "plugin.yaml"),
      "name: demo\ndescription: demo\n",
      "utf8",
    );
    await fs.mkdir(path.dirname(linkedPackageInNodeModules), {
      recursive: true,
    });
    await fs.symlink(linkedPackageSource, linkedPackageInNodeModules, "dir");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(tempRoot, {
      packageNames: ["@acme/junior-plugin-link"],
    });

    expect(discovered.packageNames).toContain("@acme/junior-plugin-link");
    expect(discovered.manifestRoots).toContain(
      path.resolve(linkedPackageInNodeModules),
    );
    expect(discovered.tracingIncludes).toContain(
      "./node_modules/@acme/junior-plugin-link/plugin.yaml",
    );
    expect(discovered.tracingIncludes).toContain(
      "./node_modules/@acme/junior-plugin-link/skills/**/*",
    );
  });

  it("resolves explicit packageNames through ancestor node_modules package resolution", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const appRoot = path.join(tempRoot, "apps", "example");
    const packageRoot = await writePluginPackage(
      path.join(tempRoot, "node_modules"),
      "@acme/junior-plugin-ancestor",
      { entryPoint: false },
    );

    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(
      path.join(appRoot, "package.json"),
      JSON.stringify({
        name: "example",
        dependencies: {
          "@acme/junior-plugin-ancestor": "1.0.0",
        },
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "workspace", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(appRoot, {
      packageNames: ["@acme/junior-plugin-ancestor"],
    });

    expect(discovered.packageNames).toContain("@acme/junior-plugin-ancestor");
    expect(discovered.manifestRoots).toContain(packageRoot);
    expect(discovered.skillRoots).toContain(path.join(packageRoot, "skills"));
    expect(discovered.tracingIncludes).toEqual([]);
  });

  it("does not fallback scan when explicit packageNames is empty", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    await writePluginPackage(
      path.join(tempRoot, "node_modules"),
      "@acme/junior-plugin-demo",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(tempRoot, {
      packageNames: [],
    });
    expect(discovered.packageNames).toEqual([]);
    expect(discovered.manifestRoots).toEqual([]);
    expect(discovered.skillRoots).toEqual([]);
    expect(discovered.tracingIncludes).toEqual([]);
  });
});
