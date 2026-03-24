import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHomeDir } from "@/chat/discovery";
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

describe("cwd-shifted discovery regression", () => {
  it("keeps app/SOUL and plugin package discovery aligned when cwd is not app root", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-cwd-regression-"),
    );
    const appDir = path.join(tempRoot, "app");
    const nestedRuntimeCwd = path.join(tempRoot, ".next", "server");
    const nodeModulesRoot = path.join(tempRoot, "node_modules");
    const pluginRoot = await writePluginPackage(
      nodeModulesRoot,
      "@acme/junior-plugin-demo",
    );

    await fs.mkdir(appDir, { recursive: true });
    await fs.mkdir(nestedRuntimeCwd, { recursive: true });
    await fs.writeFile(path.join(appDir, "SOUL.md"), "hello", "utf8");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({ name: "temp", private: true }),
      "utf8",
    );

    expect(resolveHomeDir(nestedRuntimeCwd)).toBe(appDir);

    const discovered = discoverInstalledPluginPackageContent(nestedRuntimeCwd);
    expect(discovered.manifestRoots).toContain(pluginRoot);
    expect(discovered.skillRoots).toContain(path.join(pluginRoot, "skills"));
  });
});
