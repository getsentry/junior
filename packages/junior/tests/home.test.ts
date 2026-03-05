import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir, dataRoots, homeDir, pluginRoots, pluginsDir, skillRoots, skillsDir, soulPath, soulPathCandidates } from "@/chat/home";

describe("home paths", () => {
  it("uses app as project root", () => {
    expect(homeDir()).toBe(path.resolve(process.cwd(), "app"));
  });

  it("resolves data/SOUL.md with canonical-first fallback", () => {
    const canonical = path.resolve(process.cwd(), "app", "data");
    const legacy = path.resolve(process.cwd(), "data");
    const expected = canonical;
    expect(dataDir()).toBe(expected);
    expect(soulPath()).toBe(path.join(expected, "SOUL.md"));
    expect(dataRoots()).toEqual(expect.arrayContaining([canonical, legacy]));
    expect(soulPathCandidates()).toEqual(expect.arrayContaining([path.join(canonical, "SOUL.md"), path.join(legacy, "SOUL.md")]));
  });

  it("resolves skills and plugins with canonical-first fallback", () => {
    const canonicalSkills = path.resolve(process.cwd(), "app", "skills");
    const legacySkills = path.resolve(process.cwd(), "skills");
    const expectedSkills = canonicalSkills;
    expect(skillsDir()).toBe(expectedSkills);
    expect(skillRoots()).toEqual(expect.arrayContaining([canonicalSkills, legacySkills]));

    const canonicalPlugins = path.resolve(process.cwd(), "app", "plugins");
    const legacyPlugins = path.resolve(process.cwd(), "plugins");
    const expectedPlugins = canonicalPlugins;
    expect(pluginsDir()).toBe(expectedPlugins);
    expect(pluginRoots()).toEqual(expect.arrayContaining([canonicalPlugins, legacyPlugins]));
  });
});
