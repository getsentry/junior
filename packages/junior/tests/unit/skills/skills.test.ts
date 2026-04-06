import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCapabilityProvider,
  isKnownConfigKey,
} from "@/chat/capabilities/catalog";
import {
  discoverSkills,
  parseSkillInvocation,
  resetSkillDiscoveryCache,
} from "@/chat/skills";
import type { SkillMetadata } from "@/chat/skills";
import * as observability from "@/chat/logging";

async function writeSkillFile(
  rootDir: string,
  name: string,
  lines: string[],
): Promise<void> {
  const skillDir = path.join(rootDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf8");
}

const stubSkills: SkillMetadata[] = [
  { name: "brief", description: "Candidate brief", skillPath: "/tmp/brief" },
  { name: "sum", description: "Summarize", skillPath: "/tmp/sum" },
];
const ORIGINAL_EXTRA_PLUGIN_ROOTS = process.env.JUNIOR_EXTRA_PLUGIN_ROOTS;

describe("skills", () => {
  afterEach(() => {
    resetSkillDiscoveryCache();
    if (ORIGINAL_EXTRA_PLUGIN_ROOTS === undefined) {
      delete process.env.JUNIOR_EXTRA_PLUGIN_ROOTS;
    } else {
      process.env.JUNIOR_EXTRA_PLUGIN_ROOTS = ORIGINAL_EXTRA_PLUGIN_ROOTS;
    }
  });

  it("discovers valid skills from configured skill directories", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skills-default-"),
    );
    const originalSkillDirs = process.env.SKILL_DIRS;

    await writeSkillFile(tempRoot, "brief", [
      "---",
      "name: brief",
      "description: Candidate brief",
      "---",
      "",
      "# Body",
    ]);
    await writeSkillFile(tempRoot, "sum", [
      "---",
      "name: sum",
      "description: Summarize",
      "---",
      "",
      "# Body",
    ]);

    resetSkillDiscoveryCache();
    process.env.SKILL_DIRS = tempRoot;

    try {
      const skills = await discoverSkills();
      const names = skills.map((skill) => skill.name);

      expect(names).toContain("brief");
      expect(names).toContain("sum");
    } finally {
      resetSkillDiscoveryCache();
      if (originalSkillDirs === undefined) {
        delete process.env.SKILL_DIRS;
      } else {
        process.env.SKILL_DIRS = originalSkillDirs;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not parse invocation without slash command", () => {
    expect(
      parseSkillInvocation("please summarize this candidate", stubSkills),
    ).toBeNull();
  });

  it("parses /skill tokens anywhere in the message", () => {
    expect(
      parseSkillInvocation("hey /brief github: octocat", stubSkills),
    ).toEqual({
      skillName: "brief",
      args: "github: octocat",
    });
  });

  it("parses /skill invocation", () => {
    expect(
      parseSkillInvocation("hey /brief github: octocat", stubSkills),
    ).toEqual({
      skillName: "brief",
      args: "github: octocat",
    });
  });

  it("returns null for unregistered slash command", () => {
    expect(parseSkillInvocation("/jr link sentry", stubSkills)).toBeNull();
  });

  it("returns null when no skills are available", () => {
    expect(parseSkillInvocation("/brief github: octocat", [])).toBeNull();
  });

  it("skips skills with unknown capability/config metadata and logs warnings", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-skills-"));
    const originalSkillDirs = process.env.SKILL_DIRS;
    const warnSpy = vi
      .spyOn(observability, "logWarn")
      .mockImplementation(() => undefined);

    try {
      await writeSkillFile(tempRoot, "tmp-valid-metadata", [
        "---",
        "name: tmp-valid-metadata",
        "description: Valid metadata skill.",
        "---",
        "",
        "# Body",
      ]);
      await writeSkillFile(tempRoot, "tmp-invalid-capability", [
        "---",
        "name: tmp-invalid-capability",
        "description: Invalid capability metadata skill.",
        "requires-capabilities: github.unknown.read",
        "---",
        "",
        "# Body",
      ]);
      await writeSkillFile(tempRoot, "tmp-invalid-config", [
        "---",
        "name: tmp-invalid-config",
        "description: Invalid config metadata skill.",
        "uses-config: github.organization",
        "---",
        "",
        "# Body",
      ]);

      process.env.SKILL_DIRS = tempRoot;
      resetSkillDiscoveryCache();

      const skills = await discoverSkills();
      const names = skills.map((skill) => skill.name);

      expect(names).toContain("tmp-valid-metadata");
      expect(names).not.toContain("tmp-invalid-capability");
      expect(names).not.toContain("tmp-invalid-config");

      const warningCalls = warnSpy.mock.calls.filter(
        ([event]) => event === "skill_frontmatter_invalid",
      );
      const warningMessages = warningCalls
        .map((call) => call[2])
        .map((attributes) => String(attributes?.["error.message"] ?? ""));
      expect(
        warningMessages.some((message) =>
          message.includes("Unknown requires-capabilities values"),
        ),
      ).toBe(true);
      expect(
        warningMessages.some((message) =>
          message.includes("Unknown uses-config values"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
      resetSkillDiscoveryCache();
      if (originalSkillDirs === undefined) {
        delete process.env.SKILL_DIRS;
      } else {
        process.env.SKILL_DIRS = originalSkillDirs;
      }
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("discovers plugin skills and capabilities added after module load", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-skill-late-load-"),
    );
    const pluginRoot = path.join(tempRoot, "demo");

    try {
      await fs.mkdir(path.join(pluginRoot, "skills", "demo-connect"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(pluginRoot, "plugin.yaml"),
        [
          "name: demo",
          "description: Demo plugin",
          "capabilities:",
          "  - read",
          "credentials:",
          "  type: oauth-bearer",
          "  api-domains:",
          "    - demo.example.test",
          "  auth-token-env: DEMO_ACCESS_TOKEN",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginRoot, "skills", "demo-connect", "SKILL.md"),
        [
          "---",
          "name: demo-connect",
          "description: Demo plugin skill",
          "allowed-tools: bash",
          "requires-capabilities: demo.read",
          "---",
          "",
          "# Body",
        ].join("\n"),
        "utf8",
      );

      process.env.JUNIOR_EXTRA_PLUGIN_ROOTS = JSON.stringify([pluginRoot]);
      resetSkillDiscoveryCache();

      const skills = await discoverSkills();
      expect(
        skills.find((skill) => skill.name === "demo-connect"),
      ).toMatchObject({
        name: "demo-connect",
        pluginProvider: "demo",
        requiresCapabilities: ["demo.read"],
      });
      expect(getCapabilityProvider("demo.read")).toMatchObject({
        provider: "demo",
        capabilities: ["demo.read"],
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("discovers plugin skills that use config-only plugin defaults", async () => {
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-plugin-skill-config-only-"),
    );
    const pluginRoot = path.join(tempRoot, "demo");

    try {
      await fs.mkdir(path.join(pluginRoot, "skills", "demo-defaults"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(pluginRoot, "plugin.yaml"),
        [
          "name: demo",
          "description: Demo plugin",
          "config-keys:",
          "  - team",
          "  - project",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(pluginRoot, "skills", "demo-defaults", "SKILL.md"),
        [
          "---",
          "name: demo-defaults",
          "description: Demo defaults skill",
          "uses-config: demo.team demo.project",
          "---",
          "",
          "# Body",
        ].join("\n"),
        "utf8",
      );

      process.env.JUNIOR_EXTRA_PLUGIN_ROOTS = JSON.stringify([pluginRoot]);
      resetSkillDiscoveryCache();

      const skills = await discoverSkills();
      expect(
        skills.find((skill) => skill.name === "demo-defaults"),
      ).toMatchObject({
        name: "demo-defaults",
        pluginProvider: "demo",
        usesConfig: ["demo.team", "demo.project"],
      });
      expect(isKnownConfigKey("demo.team")).toBe(true);
      expect(isKnownConfigKey("demo.project")).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
