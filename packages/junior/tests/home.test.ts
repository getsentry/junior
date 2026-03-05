import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir, dataRoots, homeDir, pluginRoots, pluginsDir, skillRoots, skillsDir, soulPath, soulPathCandidates } from "@/chat/home";

describe("home paths", () => {
  it("uses app as project root", () => {
    expect(homeDir()).toBe(path.resolve(process.cwd(), "app"));
  });

  it("resolves data/SOUL.md from canonical app root", () => {
    const canonical = path.resolve(process.cwd(), "app", "data");
    const expected = canonical;
    expect(dataDir()).toBe(expected);
    expect(soulPath()).toBe(path.join(expected, "SOUL.md"));
    expect(dataRoots()).toEqual([canonical]);
    expect(soulPathCandidates()).toEqual([path.join(canonical, "SOUL.md")]);
  });

  it("resolves skills and plugins from canonical app root", () => {
    const canonicalSkills = path.resolve(process.cwd(), "app", "skills");
    const expectedSkills = canonicalSkills;
    expect(skillsDir()).toBe(expectedSkills);
    expect(skillRoots()).toEqual([canonicalSkills]);

    const canonicalPlugins = path.resolve(process.cwd(), "app", "plugins");
    const expectedPlugins = canonicalPlugins;
    expect(pluginsDir()).toBe(expectedPlugins);
    expect(pluginRoots()).toEqual([canonicalPlugins]);
  });
});
