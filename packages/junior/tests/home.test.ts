import fs from "node:fs";
import os from "node:os";
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

  it("falls back to bundled runtime assets when workspace data is missing", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jr-home-"));
    const bundledRoot = path.join(tempRoot, ".next", "server", "runtime-assets");
    fs.mkdirSync(path.join(bundledRoot, "data"), { recursive: true });
    fs.writeFileSync(path.join(bundledRoot, "data", "SOUL.md"), "# soul");

    const previousCwd = process.cwd();
    process.chdir(tempRoot);
    try {
      expect(homeDir()).toBe(bundledRoot);
      expect(dataDir()).toBe(path.join(bundledRoot, "data"));
      expect(soulPath()).toBe(path.join(bundledRoot, "data", "SOUL.md"));
      expect(skillsDir()).toBe(path.join(bundledRoot, "skills"));
      expect(pluginsDir()).toBe(path.join(bundledRoot, "plugins"));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
