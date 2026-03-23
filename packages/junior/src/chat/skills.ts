import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parse as parseYaml } from "yaml";
import {
  isKnownCapability,
  isKnownConfigKey,
} from "@/chat/capabilities/catalog";
import { skillRoots } from "@/chat/discovery";
import { logWarn } from "@/chat/logging";
import {
  getPluginForSkillPath,
  getPluginSkillRoots,
} from "@/chat/plugins/registry";

// ---------------------------------------------------------------------------
// Skill frontmatter parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const DOTTED_TOKEN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

export interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
  metadata?: Record<string, unknown>;
  compatibility?: string;
  license?: string;
  allowedTools?: string[];
  requiresCapabilities?: string[];
  usesConfig?: string[];
}

function hasAngleBrackets(value: string): boolean {
  return value.includes("<") || value.includes(">");
}

function validateSkillName(name: string): string | null {
  if (!name) return "name must not be empty";
  if (name.length > MAX_NAME_LENGTH)
    return `name must be <= ${MAX_NAME_LENGTH} characters`;
  if (!SKILL_NAME_RE.test(name))
    return "name must contain only lowercase letters, digits, and hyphens";
  if (name.startsWith("-") || name.endsWith("-"))
    return "name must not start or end with a hyphen";
  if (name.includes("--")) return "name must not contain consecutive hyphens";
  return null;
}

function createTokenFieldSchema(
  fieldName: "requires-capabilities" | "uses-config",
  example: string,
) {
  return z
    .string({
      error: `Frontmatter field "${fieldName}" must be a string when present`,
    })
    .superRefine((value, ctx) => {
      const tokens = value
        .split(/\s+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 0);

      for (const token of tokens) {
        if (!DOTTED_TOKEN_RE.test(token)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${fieldName} token "${token}" is invalid; expected dotted lowercase tokens (for example "${example}")`,
          });
          return;
        }
      }
    });
}

function parseTokenList(value: string | undefined): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const tokens = value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  return tokens.length > 0 ? tokens : undefined;
}

const skillFrontmatterSchema = z
  .object({
    name: z
      .string({ error: 'Frontmatter field "name" must be a string' })
      .superRefine((value, ctx) => {
        const nameError = validateSkillName(value);
        if (nameError) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: nameError,
          });
        }
      }),
    description: z
      .string({ error: 'Frontmatter field "description" must be a string' })
      .superRefine((value, ctx) => {
        if (!value.trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "description must not be empty",
          });
          return;
        }
        if (value.length > MAX_DESCRIPTION_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `description must be <= ${MAX_DESCRIPTION_LENGTH} characters`,
          });
          return;
        }
        if (hasAngleBrackets(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'description must not contain "<" or ">"',
          });
        }
      }),
    metadata: z
      .record(z.string(), z.unknown(), {
        error: 'Frontmatter field "metadata" must be an object when present',
      })
      .optional(),
    compatibility: z
      .string({
        error:
          'Frontmatter field "compatibility" must be a string when present',
      })
      .superRefine((value, ctx) => {
        if (value.length > MAX_COMPATIBILITY_LENGTH) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `compatibility must be <= ${MAX_COMPATIBILITY_LENGTH} characters`,
          });
        }
      })
      .optional(),
    license: z
      .string({
        error: 'Frontmatter field "license" must be a string when present',
      })
      .optional(),
    "allowed-tools": z
      .string({
        error:
          'Frontmatter field "allowed-tools" must be a string when present',
      })
      .optional(),
    "requires-capabilities": createTokenFieldSchema(
      "requires-capabilities",
      "github.issues.write",
    ).optional(),
    "uses-config": createTokenFieldSchema(
      "uses-config",
      "github.repo",
    ).optional(),
  })
  .passthrough();

/** Strip YAML frontmatter from a skill file, returning only the body. */
export function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "").trim();
}

/** Parse a SKILL.md file's frontmatter and body. */
export function parseSkillFile(
  raw: string,
  expectedName?: string,
): { ok: true; skill: ParsedSkillFile } | { ok: false; error: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { ok: false, error: "Missing YAML frontmatter at start of file" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Frontmatter must be a YAML object" };
  }

  const result = skillFrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    return {
      ok: false,
      error: result.error.issues[0]?.message ?? "Invalid YAML frontmatter",
    };
  }

  if (expectedName && result.data.name !== expectedName) {
    return {
      ok: false,
      error: `name "${result.data.name}" must match directory "${expectedName}"`,
    };
  }

  const allowedTools = parseTokenList(result.data["allowed-tools"]);
  const requiresCapabilities = parseTokenList(
    result.data["requires-capabilities"],
  );
  const usesConfig = parseTokenList(result.data["uses-config"]);

  return {
    ok: true,
    skill: {
      name: result.data.name,
      description: result.data.description,
      body: stripFrontmatter(raw),
      ...(result.data.metadata ? { metadata: result.data.metadata } : {}),
      ...(result.data.compatibility !== undefined
        ? { compatibility: result.data.compatibility }
        : {}),
      ...(result.data.license !== undefined
        ? { license: result.data.license }
        : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(requiresCapabilities ? { requiresCapabilities } : {}),
      ...(usesConfig ? { usesConfig } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Skill discovery and loading
// ---------------------------------------------------------------------------

const SKILL_CACHE_TTL_MS = 5000;

export interface SkillMetadata {
  name: string;
  description: string;
  skillPath: string;
  pluginProvider?: string;
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

/** Clear the cached skill discovery results so the next call re-scans disk. */
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
    const plugin = getPluginForSkillPath(skillDir);
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
      ...(plugin ? { pluginProvider: plugin.manifest.name } : {}),
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

/** Scan all configured skill roots and return discovered skill metadata, using a cache when roots match. */
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

/** Extract a skill invocation (name + args) from a user message, or return null if none matches. */
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

/** Look up a skill by name from the available set. */
export function findSkillByName(
  skillName: string,
  available: SkillMetadata[],
): SkillMetadata | null {
  return available.find((skill) => skill.name === skillName) ?? null;
}

/** Load full skill bodies for a list of skill names, reading SKILL.md files from disk. */
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
