import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

export interface SkillFrontmatter {
  name: string;
  description: string;
  metadata?: Record<string, unknown>;
  compatibility?: string;
  license?: string;
  "allowed-tools"?: string;
  [key: string]: unknown;
}

function hasAngleBrackets(value: string): boolean {
  return value.includes("<") || value.includes(">");
}

function validateSkillName(name: string): string | null {
  if (!name) return "name must not be empty";
  if (name.length > MAX_NAME_LENGTH) return `name must be <= ${MAX_NAME_LENGTH} characters`;
  if (!SKILL_NAME_RE.test(name)) return "name must contain only lowercase letters, digits, and hyphens";
  if (name.startsWith("-") || name.endsWith("-")) return "name must not start or end with a hyphen";
  if (name.includes("--")) return "name must not contain consecutive hyphens";
  return null;
}

export function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "").trim();
}

export function parseAndValidateSkillFrontmatter(
  raw: string,
  expectedName?: string
): { ok: true; frontmatter: SkillFrontmatter } | { ok: false; error: string } {
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
      error: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Frontmatter must be a YAML object" };
  }

  const frontmatter = parsed as Record<string, unknown>;
  const name = frontmatter.name;
  const description = frontmatter.description;

  if (typeof name !== "string") {
    return { ok: false, error: 'Frontmatter field "name" must be a string' };
  }
  const nameError = validateSkillName(name);
  if (nameError) {
    return { ok: false, error: nameError };
  }
  if (expectedName && name !== expectedName) {
    return { ok: false, error: `name "${name}" must match directory "${expectedName}"` };
  }

  if (typeof description !== "string") {
    return { ok: false, error: 'Frontmatter field "description" must be a string' };
  }
  if (!description.trim()) {
    return { ok: false, error: "description must not be empty" };
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, error: `description must be <= ${MAX_DESCRIPTION_LENGTH} characters` };
  }
  if (hasAngleBrackets(description)) {
    return { ok: false, error: 'description must not contain "<" or ">"' };
  }

  if ("metadata" in frontmatter && (typeof frontmatter.metadata !== "object" || !frontmatter.metadata || Array.isArray(frontmatter.metadata))) {
    return { ok: false, error: 'Frontmatter field "metadata" must be an object when present' };
  }
  if ("compatibility" in frontmatter) {
    if (typeof frontmatter.compatibility !== "string") {
      return { ok: false, error: 'Frontmatter field "compatibility" must be a string when present' };
    }
    if (frontmatter.compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      return { ok: false, error: `compatibility must be <= ${MAX_COMPATIBILITY_LENGTH} characters` };
    }
  }
  if ("license" in frontmatter && typeof frontmatter.license !== "string") {
    return { ok: false, error: 'Frontmatter field "license" must be a string when present' };
  }
  if ("allowed-tools" in frontmatter && typeof frontmatter["allowed-tools"] !== "string") {
    return { ok: false, error: 'Frontmatter field "allowed-tools" must be a string when present' };
  }

  return {
    ok: true,
    frontmatter: {
      ...(frontmatter as SkillFrontmatter),
      name,
      description
    }
  };
}
