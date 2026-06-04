import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCompiledContentGraph } from "@/build/compiled-content";
import {
  COMPILED_APP_ROOT,
  readRuntimeFileSync,
  setRuntimeContent,
} from "@/chat/content";
import { listReferenceFiles, resolveHomeDir } from "@/chat/discovery";
import {
  getPluginProviders,
  setPluginCatalogConfig,
} from "@/chat/plugins/registry";
import {
  discoverSkills,
  loadSkillsByName,
  resetSkillDiscoveryCache,
} from "@/chat/skills";
import { buildSystemPrompt } from "@/chat/prompt";

const originalCwd = process.cwd();
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-compiled-content-"),
  );
  tempDirs.push(tempDir);
  return tempDir;
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", body].join(
      "\n",
    ),
    "utf8",
  );
}

async function writePluginManifest(
  root: string,
  name: string,
  description = `${name} plugin`,
): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "plugin.yaml"),
    [`name: ${name}`, `description: ${description}`].join("\n"),
    "utf8",
  );
}

async function writePluginPackage(
  root: string,
  packageName: string,
  pluginName: string,
  description = `${pluginName} plugin`,
): Promise<string> {
  const packageRoot = path.join(
    root,
    "node_modules",
    ...packageName.split("/"),
  );
  await writePluginManifest(packageRoot, pluginName, description);
  return packageRoot;
}

afterEach(async () => {
  process.chdir(originalCwd);
  setRuntimeContent(undefined);
  setPluginCatalogConfig(undefined);
  resetSkillDiscoveryCache();
  for (const tempDir of tempDirs.splice(0)) {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

describe("compiled Junior content", () => {
  it("loads app files, app plugins, app skills, and package plugins from the graph", async () => {
    const tempRoot = await makeTempDir();
    const appRoot = path.join(tempRoot, "app");
    const appPluginRoot = path.join(appRoot, "plugins", "bundle");

    await fs.mkdir(appRoot, { recursive: true });
    await fs.writeFile(path.join(appRoot, "SOUL.md"), "Compiled soul", "utf8");
    await fs.writeFile(
      path.join(appRoot, "WORLD.md"),
      "Compiled world",
      "utf8",
    );
    await fs.writeFile(
      path.join(appRoot, "REFERENCE.md"),
      "Compiled reference",
      "utf8",
    );
    await writeSkill(
      path.join(appRoot, "skills"),
      "local-skill",
      "Local skill",
      "Local body",
    );

    await writePluginManifest(appPluginRoot, "bundle", "Bundle plugin");
    await writeSkill(
      path.join(appPluginRoot, "skills"),
      "bundle-skill",
      "Bundle skill",
      "Bundle body",
    );

    const packageRoot = await writePluginPackage(
      tempRoot,
      "@acme/junior-demo",
      "pkg",
      "Package plugin",
    );
    await writeSkill(
      path.join(packageRoot, "skills"),
      "pkg-skill",
      "Package skill",
      "Package body",
    );
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "compiled-content-app",
        private: true,
        dependencies: {
          "@acme/junior-demo": "1.0.0",
        },
      }),
      "utf8",
    );

    const content = buildCompiledContentGraph(tempRoot, ["@acme/junior-demo"]);
    expect(Object.keys(content.files).every((key) => !key.includes("\\"))).toBe(
      true,
    );
    await fs.rm(appRoot, { recursive: true, force: true });
    await fs.rm(path.join(tempRoot, "node_modules"), {
      recursive: true,
      force: true,
    });
    const runtimeCwd = path.join(tempRoot, "runtime");
    await fs.mkdir(runtimeCwd);
    process.chdir(runtimeCwd);

    setRuntimeContent(content);
    setPluginCatalogConfig({ packages: ["@acme/junior-demo"] });

    expect(resolveHomeDir()).toBe(COMPILED_APP_ROOT);
    expect(readRuntimeFileSync(`${COMPILED_APP_ROOT}\\SOUL.md`)).toBe(
      "Compiled soul",
    );
    expect(buildSystemPrompt()).toContain("Compiled soul");
    expect(buildSystemPrompt()).toContain("Compiled world");
    expect(listReferenceFiles()).toEqual([
      path.join(COMPILED_APP_ROOT, "REFERENCE.md"),
    ]);

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "bundle",
      "pkg",
    ]);

    const skills = await discoverSkills();
    expect(skills.map((skill) => [skill.name, skill.pluginProvider])).toEqual([
      ["bundle-skill", "bundle"],
      ["local-skill", undefined],
      ["pkg-skill", "pkg"],
    ]);

    const loaded = await loadSkillsByName(["pkg-skill"], skills);
    expect(loaded[0]?.body).toContain("Plugin Runtime Boundary");
    expect(loaded[0]?.body).toContain("Package body");
  });

  it("filters compiled package plugins through the active plugin catalog", async () => {
    const tempRoot = await makeTempDir();
    await writePluginPackage(tempRoot, "@acme/a", "a");
    await writePluginPackage(tempRoot, "@acme/b", "b");
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "compiled-content-app",
        private: true,
        dependencies: {
          "@acme/a": "1.0.0",
          "@acme/b": "1.0.0",
        },
      }),
      "utf8",
    );

    setRuntimeContent(
      buildCompiledContentGraph(tempRoot, ["@acme/a", "@acme/b"]),
    );
    setPluginCatalogConfig({ packages: ["@acme/a"] });

    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "a",
    ]);
  });

  it("reloads plugin manifests when compiled content is replaced", async () => {
    const tempRoot = await makeTempDir();
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "compiled-content-app",
        private: true,
        dependencies: {
          "@acme/a": "1.0.0",
        },
      }),
      "utf8",
    );

    const packageRoot = await writePluginPackage(
      tempRoot,
      "@acme/a",
      "a",
      "old",
    );
    setRuntimeContent(buildCompiledContentGraph(tempRoot, ["@acme/a"]));
    setPluginCatalogConfig({ packages: ["@acme/a"] });
    expect(getPluginProviders()[0]?.manifest.description).toBe("old");

    await writePluginManifest(packageRoot, "a", "new");
    setRuntimeContent(buildCompiledContentGraph(tempRoot, ["@acme/a"]));

    expect(getPluginProviders()[0]?.manifest.description).toBe("new");
  });

  it("follows symlinked app plugin directories when compiling content", async () => {
    const tempRoot = await makeTempDir();
    const linkedPluginSource = path.join(tempRoot, "linked-plugin-source");
    const linkedPluginTarget = path.join(tempRoot, "app", "plugins", "linked");
    await writePluginManifest(linkedPluginSource, "linked");
    await fs.mkdir(path.dirname(linkedPluginTarget), { recursive: true });
    await fs.symlink(linkedPluginSource, linkedPluginTarget, "dir");

    const content = buildCompiledContentGraph(tempRoot);
    expect(
      readRuntimeFileSync(
        path.join(COMPILED_APP_ROOT, "plugins", "linked", "plugin.yaml"),
      ),
    ).toBeNull();
    setRuntimeContent(content);

    expect(
      readRuntimeFileSync(
        path.join(COMPILED_APP_ROOT, "plugins", "linked", "plugin.yaml"),
      ),
    ).toContain("name: linked");
    expect(getPluginProviders().map((plugin) => plugin.manifest.name)).toEqual([
      "linked",
    ]);
  });
});
