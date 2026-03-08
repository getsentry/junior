import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  dataDir,
  dataRoots,
  homeDir,
  pluginRoots,
  pluginsDir,
  resolveHomeDir,
  skillRoots,
  skillsDir,
  soulPath,
  soulPathCandidates
} from "@/chat/home";

describe("home paths", () => {
  it("uses app as project root", () => {
    expect(homeDir()).toBe(path.resolve(process.cwd(), "app"));
  });

  it("resolves data/SOUL.md from canonical app root", () => {
    const appRoot = path.resolve(process.cwd(), "app");
    expect(dataDir()).toBe(appRoot);
    expect(soulPath()).toBe(path.join(appRoot, "SOUL.md"));
    expect(dataRoots()).toEqual([appRoot]);
    expect(soulPathCandidates()).toEqual([
      path.join(appRoot, "SOUL.md")
    ]);
  });

  it("resolves skills and plugins from canonical app root", () => {
    const canonicalSkills = path.resolve(process.cwd(), "app", "skills");
    const packageSkills = path.resolve(process.cwd(), "skills");
    expect(skillsDir()).toBe(canonicalSkills);
    expect(skillRoots()).toEqual([canonicalSkills, packageSkills]);

    const canonicalPlugins = path.resolve(process.cwd(), "app", "plugins");
    expect(pluginsDir()).toBe(canonicalPlugins);
    expect(pluginRoots()).toEqual([canonicalPlugins]);
  });

  it("prefers candidate app roots with SOUL markers", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-home-dir-"));
    const runtimeDistRoot = path.join(tempRoot, "runtime-dist");
    const projectRoot = path.join(tempRoot, "project-root");
    const runtimeApp = path.join(runtimeDistRoot, "app");
    const projectApp = path.join(projectRoot, "app");

    await fs.mkdir(runtimeApp, { recursive: true });
    await fs.mkdir(projectApp, { recursive: true });
    await fs.writeFile(path.join(projectApp, "SOUL.md"), "soul", "utf8");

    expect(resolveHomeDir(tempRoot, { projectRoots: [runtimeDistRoot, projectRoot] })).toBe(projectApp);
  });
});
