import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir, homeDir, pluginsDir, skillsDir, soulPath } from "@/chat/home";

describe("home paths", () => {
  it("uses app as project root", () => {
    expect(homeDir()).toBe(path.resolve(process.cwd(), "app"));
  });

  it("resolves data/SOUL.md under app", () => {
    expect(dataDir()).toBe(path.resolve(process.cwd(), "app", "data"));
    expect(soulPath()).toBe(path.resolve(process.cwd(), "app", "data", "SOUL.md"));
  });

  it("resolves skills and plugins directories under app", () => {
    expect(skillsDir()).toBe(path.resolve(process.cwd(), "app", "skills"));
    expect(pluginsDir()).toBe(path.resolve(process.cwd(), "app", "plugins"));
  });
});
