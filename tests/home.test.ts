import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataDir, homeDir, pluginsDir, skillsDir, soulPath } from "@/chat/home";

describe("home paths", () => {
  it("uses cwd as project root", () => {
    expect(homeDir()).toBe(path.resolve(process.cwd()));
  });

  it("resolves data/SOUL.md under project root", () => {
    expect(dataDir()).toBe(path.resolve(process.cwd(), "data"));
    expect(soulPath()).toBe(path.resolve(process.cwd(), "data", "SOUL.md"));
  });

  it("resolves top-level skills and plugins directories", () => {
    expect(skillsDir()).toBe(path.resolve(process.cwd(), "skills"));
    expect(pluginsDir()).toBe(path.resolve(process.cwd(), "plugins"));
  });
});
