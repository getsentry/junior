import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PluginAppFixture {
  cleanup(): Promise<void>;
  root: string;
}

export interface PluginAppFixtureOptions {
  linkNodeModules?: boolean;
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function listPluginDirs(root: string): Promise<string[]> {
  if (await exists(path.join(root, "plugin.yaml"))) {
    return [root];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const pluginDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(root, entry.name);
    if (await exists(path.join(candidate, "plugin.yaml"))) {
      pluginDirs.push(candidate);
    }
  }
  return pluginDirs;
}

async function linkNodeModules(root: string, fromCwd: string): Promise<void> {
  const source = path.join(fromCwd, "node_modules");
  if (!(await isDirectory(source))) {
    return;
  }
  await fs.symlink(source, path.join(root, "node_modules"), "dir");
}

async function nextLinkPath(
  pluginsRoot: string,
  source: string,
): Promise<string> {
  const base = path.basename(source);
  let candidate = path.join(pluginsRoot, base);
  let suffix = 2;
  while (await exists(candidate)) {
    candidate = path.join(pluginsRoot, `${base}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

/** Create a temporary app/plugins root so tests exercise normal plugin discovery. */
export async function createPluginAppFixture(
  pluginRoots: string[],
  options: PluginAppFixtureOptions = {},
): Promise<PluginAppFixture> {
  const previousCwd = process.cwd();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "junior-plugin-app-"));
  const pluginsRoot = path.join(root, "app", "plugins");
  await fs.mkdir(pluginsRoot, { recursive: true });
  if (options.linkNodeModules) {
    await linkNodeModules(root, previousCwd);
  }

  for (const pluginRoot of pluginRoots) {
    for (const pluginDir of await listPluginDirs(pluginRoot)) {
      await fs.symlink(
        pluginDir,
        await nextLinkPath(pluginsRoot, pluginDir),
        "dir",
      );
    }
  }

  process.chdir(root);
  return {
    root,
    async cleanup() {
      process.chdir(previousCwd);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
