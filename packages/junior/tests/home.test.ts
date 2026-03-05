import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir, dataRoots, homeDir, pluginRoots, pluginsDir, skillRoots, skillsDir, soulPath, soulPathCandidates } from "@/chat/home";

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
    expect(skillsDir()).toBe(canonicalSkills);
    expect(skillRoots()).toEqual([canonicalSkills]);

    const canonicalPlugins = path.resolve(process.cwd(), "app", "plugins");
    expect(pluginsDir()).toBe(canonicalPlugins);
    expect(pluginRoots()).toEqual([canonicalPlugins]);
  });
});
