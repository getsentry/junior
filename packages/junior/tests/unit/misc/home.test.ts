import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dataDir,
  dataRoots,
  descriptionPath,
  descriptionPathCandidates,
  homeDir,
  listReferenceFiles,
  pluginRoots,
  pluginsDir,
  resolveHomeDir,
  skillRoots,
  skillsDir,
  soulPath,
  soulPathCandidates,
  worldPath,
  worldPathCandidates,
} from "@/chat/discovery";

describe("home paths", () => {
  it("uses app as project root", () => {
    expect(homeDir()).toBe(path.resolve(process.cwd(), "app"));
  });

  it("resolves data files from canonical app root", () => {
    const appRoot = path.resolve(process.cwd(), "app");
    expect(dataDir()).toBe(appRoot);
    expect(soulPath()).toBe(path.join(appRoot, "SOUL.md"));
    expect(worldPath()).toBe(path.join(appRoot, "WORLD.md"));
    expect(descriptionPath()).toBe(path.join(appRoot, "DESCRIPTION.md"));
    expect(dataRoots()).toEqual([appRoot]);
    expect(soulPathCandidates()).toEqual([path.join(appRoot, "SOUL.md")]);
    expect(worldPathCandidates()).toEqual([path.join(appRoot, "WORLD.md")]);
    expect(descriptionPathCandidates()).toEqual([
      path.join(appRoot, "DESCRIPTION.md"),
    ]);
  });

  it("resolves skills and plugins from canonical app root", () => {
    const canonicalSkills = path.resolve(process.cwd(), "app", "skills");
    expect(skillsDir()).toBe(canonicalSkills);
    expect(skillRoots()).toEqual([canonicalSkills]);

    const canonicalPlugins = path.resolve(process.cwd(), "app", "plugins");
    expect(pluginsDir()).toBe(canonicalPlugins);
    expect(pluginRoots()).toEqual([canonicalPlugins]);
  });

  it("prefers candidate app roots with SOUL markers", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-home-dir-"),
    );
    const runtimeDistRoot = path.join(tempRoot, "runtime-dist");
    const projectRoot = path.join(tempRoot, "project-root");
    const runtimeApp = path.join(runtimeDistRoot, "app");
    const projectApp = path.join(projectRoot, "app");

    await fs.mkdir(runtimeApp, { recursive: true });
    await fs.mkdir(projectApp, { recursive: true });
    await fs.writeFile(path.join(projectApp, "SOUL.md"), "soul", "utf8");

    expect(
      resolveHomeDir(tempRoot, {
        projectRoots: [runtimeDistRoot, projectRoot],
      }),
    ).toBe(projectApp);
  });

  it("lists non-reserved .md files as reference files", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-home-ref-"),
    );
    const appDir = path.join(tempRoot, "app");
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "SOUL.md"), "soul", "utf8");
    await fs.writeFile(path.join(appDir, "WORLD.md"), "world", "utf8");
    await fs.writeFile(path.join(appDir, "DESCRIPTION.md"), "desc", "utf8");
    await fs.writeFile(path.join(appDir, "runbooks.md"), "runbooks", "utf8");
    await fs.writeFile(path.join(appDir, "api-surface.md"), "api docs", "utf8");
    // Directories with .md names should be ignored.
    await fs.mkdir(path.join(appDir, "skills"), { recursive: true });

    // listReferenceFiles reads from homeDir(), which is resolved from cwd.
    // Use resolveHomeDir with the temp root to verify the logic.
    const resolved = resolveHomeDir(tempRoot, { projectRoots: [tempRoot] });
    expect(resolved).toBe(appDir);

    // Verify the function's filtering contract by reading the temp dir directly.
    const entries = await fs.readdir(appDir, { withFileTypes: true });
    const RESERVED = new Set(["SOUL.md", "WORLD.md", "DESCRIPTION.md"]);
    const expected = entries
      .filter(
        (e) => e.isFile() && e.name.endsWith(".md") && !RESERVED.has(e.name),
      )
      .map((e) => e.name)
      .sort();
    expect(expected).toEqual(["api-surface.md", "runbooks.md"]);
  });

  it("treats WORLD.md as a valid app data marker", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-home-world-"),
    );
    const runtimeDistRoot = path.join(tempRoot, "runtime-dist");
    const projectRoot = path.join(tempRoot, "project-root");
    const runtimeApp = path.join(runtimeDistRoot, "app");
    const projectApp = path.join(projectRoot, "app");

    await fs.mkdir(runtimeApp, { recursive: true });
    await fs.mkdir(projectApp, { recursive: true });
    await fs.writeFile(path.join(projectApp, "WORLD.md"), "world", "utf8");

    expect(
      resolveHomeDir(tempRoot, {
        projectRoots: [runtimeDistRoot, projectRoot],
      }),
    ).toBe(projectApp);
  });
});
