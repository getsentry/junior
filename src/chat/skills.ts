import fs from "node:fs/promises";
import path from "node:path";
import { parseAndValidateSkillFrontmatter, stripFrontmatter } from "@/chat/skill-frontmatter";

const SKILL_CACHE_TTL_MS = 5000;

export interface SkillMetadata {
  name: string;
  description: string;
  skillPath: string;
}

export interface Skill extends SkillMetadata {
  body: string;
}

export interface SkillInvocation {
  skillName: string;
  args: string;
}

let skillCache: { expiresAt: number; skills: SkillMetadata[] } | null = null;

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function resolveSkillRoots(): string[] {
  const envRoots = process.env.SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? [];
  const defaults = [path.join(process.cwd(), ".agents", "skills"), path.join(process.cwd(), "skills")];

  return [...envRoots, ...defaults];
}

async function readSkillDirectory(skillDir: string): Promise<SkillMetadata | null> {
  const skillFile = path.join(skillDir, "SKILL.md");

  try {
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseAndValidateSkillFrontmatter(raw, path.basename(skillDir));
    if (!parsed.ok) {
      return null;
    }

    const { name, description } = parsed.frontmatter;

    return {
      name,
      description,
      skillPath: skillDir
    };
  } catch {
    return null;
  }
}

export async function discoverSkills(): Promise<SkillMetadata[]> {
  if (skillCache && skillCache.expiresAt > Date.now()) {
    return skillCache.skills;
  }

  const roots = resolveSkillRoots();
  const discovered: SkillMetadata[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skill = await readSkillDirectory(path.join(root, entry.name));
        if (skill && !seen.has(skill.name)) {
          seen.add(skill.name);
          discovered.push(skill);
        }
      }
    } catch {
      // Skill roots are optional.
    }
  }

  const sorted = discovered.sort((a, b) => a.name.localeCompare(b.name));
  skillCache = {
    expiresAt: Date.now() + SKILL_CACHE_TTL_MS,
    skills: sorted
  };
  return sorted;
}

export function parseSkillInvocation(messageText: string): SkillInvocation | null {
  const trimmed = messageText.trim();
  const match = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) {
    return null;
  }

  const skillName = match[1].toLowerCase();
  const args = (match[2] ?? "").trim();

  return {
    skillName,
    args
  };
}

export function findSkillByName(skillName: string, available: SkillMetadata[]): SkillMetadata | null {
  return available.find((skill) => skill.name === skillName) ?? null;
}

export async function loadSkillsByName(skillNames: string[], available: SkillMetadata[]): Promise<Skill[]> {
  const selected = new Set(skillNames);
  const skills: Skill[] = [];

  for (const meta of available) {
    if (!selected.has(meta.name)) {
      continue;
    }

    const skillFile = path.join(meta.skillPath, "SKILL.md");
    const raw = await fs.readFile(skillFile, "utf8");

    skills.push({
      ...meta,
      body: stripFrontmatter(raw)
    });
  }

  return skills;
}

export function renderSkillMetadataXml(skills: SkillMetadata[]): string {
  const items = skills
    .map((skill) => {
      return [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <location>${escapeXml(path.join(skill.skillPath, "SKILL.md"))}</location>`,
        "  </skill>"
      ].join("\n");
    })
    .join("\n");

  return `<available_skills>\n${items}\n</available_skills>`;
}

export function renderSkillsHarnessXml(skills: SkillMetadata[]): string {
  return [
    "<skills>",
    "  <rules>",
    "    1. If the full message starts with /<skill-name>, treat it as a skill invocation request.",
    "    2. If a slash-invoked skill exists, apply that skill's instructions first.",
    "    3. If a slash-invoked skill does not exist, return an unknown-skill error and list available skills.",
    "    4. Never reinterpret slash skill commands as plain text chat intent.",
    "  </rules>",
    "  <usage>",
    "    Use format: /<skill-name> <optional arguments>",
    "  </usage>",
    renderSkillMetadataXml(skills)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
    "</skills>"
  ].join("\n");
}

export function renderActiveSkillsXml(skills: Skill[]): string {
  if (skills.length === 0) {
    return "<active_skills />";
  }

  const items = skills
    .map((skill) => {
      return [
        "  <skill>",
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description)}</description>`,
        `    <location>${escapeXml(path.join(skill.skillPath, "SKILL.md"))}</location>`,
        "    <instructions>",
        skill.body
          .split("\n")
          .map((line) => `      ${escapeXml(line)}`)
          .join("\n"),
        "    </instructions>",
        "  </skill>"
      ].join("\n");
    })
    .join("\n");

  return `<active_skills>\n${items}\n</active_skills>`;
}
