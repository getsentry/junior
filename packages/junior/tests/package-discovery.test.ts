import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";

async function writePluginPackage(
  nodeModulesRoot: string,
  packageName: string,
): Promise<string> {
  const packageRoot = path.join(nodeModulesRoot, ...packageName.split("/"));
  await fs.mkdir(path.join(packageRoot, "skills", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    "name: demo\ndescription: demo\n",
    "utf8",
  );
  return packageRoot;
}

async function writeWorkspacePlugin(
  workspaceRoot: string,
  packageDirName: string,
  packageName?: string,
): Promise<string> {
  const packageRoot = path.join(workspaceRoot, "packages", packageDirName);
  await fs.mkdir(path.join(packageRoot, "skills", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    "name: demo\ndescription: demo\n",
    "utf8",
  );
  if (packageName) {
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: packageName, private: true }),
      "utf8",
    );
  }
  return packageRoot;
}

describe("plugin package discovery", () => {
  it("discovers plugin content from node_modules even when package.json has no dependencies", async () => {
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

    const discovered = discoverInstalledPluginPackageContent(tempRoot);
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

  it("discovers sibling workspace plugin packages from pnpm-workspace members", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const appRoot = path.join(tempRoot, "packages", "junior");
    const pluginRoot = await writeWorkspacePlugin(
      tempRoot,
      "junior-plugin-demo",
    );

    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "package.json"),
      JSON.stringify({ name: "@sentry/junior", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(appRoot);
    expect(discovered.manifestRoots).toContain(pluginRoot);
    expect(discovered.skillRoots).toContain(path.join(pluginRoot, "skills"));
  });

  it("resolves explicit packageNames through sibling workspace packages", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-package-discovery-"),
    );
    const appRoot = path.join(tempRoot, "packages", "junior");
    const pluginRoot = await writeWorkspacePlugin(
      tempRoot,
      "junior-github",
      "@sentry/junior-github",
    );

    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(
      path.join(tempRoot, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "package.json"),
      JSON.stringify({ name: "@sentry/junior", private: true }),
      "utf8",
    );

    const discovered = discoverInstalledPluginPackageContent(appRoot, {
      packageNames: ["@sentry/junior-github"],
    });

    expect(discovered.packageNames).toContain("@sentry/junior-github");
    expect(discovered.manifestRoots).toContain(pluginRoot);
    expect(discovered.skillRoots).toContain(path.join(pluginRoot, "skills"));
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
