import fs from "node:fs/promises";
import path from "node:path";
import {
  isKnownCapability,
  isKnownConfigKey,
} from "@/chat/capabilities/catalog";
import { skillRoots } from "@/chat/home";
import { logWarn } from "@/chat/observability";
import { getPluginSkillRoots } from "@/chat/plugins/registry";
import { parseSkillFile } from "@/chat/skill-frontmatter";

const SKILL_CACHE_TTL_MS = 5000;

export interface SkillMetadata {
  name: string;
  description: string;
  skillPath: string;
  allowedTools?: string[];
  requiresCapabilities?: string[];
  usesConfig?: string[];
}

export interface Skill extends SkillMetadata {
  body: string;
}

export interface SkillInvocation {
  skillName: string;
  args: string;
}

export interface DiscoverSkillsOptions {
  additionalRoots?: string[];
}

let skillCache: {
  expiresAt: number;
  key: string;
  skills: SkillMetadata[];
} | null = null;

export function resetSkillDiscoveryCache(): void {
  skillCache = null;
}

function resolveSkillRoots(options?: DiscoverSkillsOptions): string[] {
  const additionalRoots = options?.additionalRoots ?? [];
  const envRoots =
    process.env.SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? [];
  const defaults = skillRoots();
  const pluginRoots = getPluginSkillRoots();

  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const root of [
    ...additionalRoots,
    ...envRoots,
    ...defaults,
    ...pluginRoots,
  ]) {
    const normalized = path.resolve(root);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    resolved.push(normalized);
  }
  return resolved;
}

function validateSkillMetadata(input: {
  requiresCapabilities?: string[];
  usesConfig?: string[];
}): string | undefined {
  const unknownCapabilities = (input.requiresCapabilities ?? []).filter(
    (capability) => !isKnownCapability(capability),
  );
  if (unknownCapabilities.length > 0) {
    return `Unknown requires-capabilities values: ${unknownCapabilities.join(", ")}`;
  }

  const unknownConfigKeys = (input.usesConfig ?? []).filter(
    (configKey) => !isKnownConfigKey(configKey),
  );
  if (unknownConfigKeys.length > 0) {
    return `Unknown uses-config values: ${unknownConfigKeys.join(", ")}`;
  }

  return undefined;
}

async function readSkillDirectory(
  skillDir: string,
): Promise<SkillMetadata | null> {
  const skillFile = path.join(skillDir, "SKILL.md");

  try {
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseSkillFile(raw, path.basename(skillDir));
    if (!parsed.ok) {
      logWarn(
        "skill_frontmatter_invalid",
        {},
        {
          "file.path": skillDir,
          "error.message": parsed.error,
        },
        "Invalid skill frontmatter",
      );
      return null;
    }

    const {
      name,
      description,
      allowedTools,
      requiresCapabilities,
      usesConfig,
    } = parsed.skill;
    const metadataError = validateSkillMetadata({
      requiresCapabilities,
      usesConfig,
    });
    if (metadataError) {
      logWarn(
        "skill_frontmatter_invalid",
        {},
        {
          "file.path": skillDir,
          "error.message": metadataError,
        },
        "Invalid skill frontmatter",
      );
      return null;
    }

    return {
      name,
      description,
      skillPath: skillDir,
      allowedTools,
      requiresCapabilities,
      usesConfig,
    };
  } catch (error) {
    logWarn(
      "skill_directory_read_failed",
      {},
      {
        "file.path": skillDir,
        "error.message": error instanceof Error ? error.message : String(error),
      },
      "Failed to read skill directory",
    );
    return null;
  }
}

export async function discoverSkills(
  options?: DiscoverSkillsOptions,
): Promise<SkillMetadata[]> {
  const roots = resolveSkillRoots(options);
  const cacheKey = roots.join(path.delimiter);
  if (
    skillCache &&
    skillCache.expiresAt > Date.now() &&
    skillCache.key === cacheKey
  ) {
    return skillCache.skills;
  }

  const discovered: SkillMetadata[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!entry.isDirectory()) {
          continue;
        }

        const skill = await readSkillDirectory(path.join(root, entry.name));
        if (skill && !seen.has(skill.name)) {
          seen.add(skill.name);
          discovered.push(skill);
        }
      }
    } catch (error) {
      logWarn(
        "skill_root_read_failed",
        {},
        {
          "file.directory": root,
          "error.message":
            error instanceof Error ? error.message : String(error),
        },
        "Failed to read skill root",
      );
    }
  }

  const sorted = discovered.sort((a, b) => a.name.localeCompare(b.name));
  skillCache = {
    expiresAt: Date.now() + SKILL_CACHE_TTL_MS,
    key: cacheKey,
    skills: sorted,
  };
  return sorted;
}

export function parseSkillInvocation(
  messageText: string,
  availableSkills: SkillMetadata[],
): SkillInvocation | null {
  const trimmed = messageText.trim();
  const match = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?/i.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }

  const skillName = match[1].toLowerCase();
  if (!availableSkills.some((skill) => skill.name === skillName)) {
    return null;
  }

  return {
    skillName,
    args: (match[2] ?? "").trim(),
  };
}

export function findSkillByName(
  skillName: string,
  available: SkillMetadata[],
): SkillMetadata | null {
  return available.find((skill) => skill.name === skillName) ?? null;
}

export async function loadSkillsByName(
  skillNames: string[],
  available: SkillMetadata[],
): Promise<Skill[]> {
  const selected = new Set(skillNames);
  const skills: Skill[] = [];

  for (const meta of available) {
    if (!selected.has(meta.name)) {
      continue;
    }

    const skillFile = path.join(meta.skillPath, "SKILL.md");
    const raw = await fs.readFile(skillFile, "utf8");
    const parsed = parseSkillFile(raw, meta.name);
    if (!parsed.ok) {
      throw new Error(`Invalid skill file in ${skillFile}: ${parsed.error}`);
    }

    skills.push({
      ...meta,
      body: parsed.skill.body,
    });
  }

  return skills;
}
