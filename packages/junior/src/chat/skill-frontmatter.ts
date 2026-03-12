import { z } from "zod";
import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const CAPABILITY_TOKEN_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
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
  "requires-capabilities"?: string;
  "uses-config"?: string;
  [key: string]: unknown;
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
        if (!CAPABILITY_TOKEN_RE.test(token)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${fieldName} token "${token}" is invalid; expected dotted lowercase tokens (for example "${example}")`,
          });
          return;
        }
      }
    });
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

export function stripFrontmatter(raw: string): string {
  return raw.replace(FRONTMATTER_RE, "").trim();
}

export function parseAndValidateSkillFrontmatter(
  raw: string,
  expectedName?: string,
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

  return {
    ok: true,
    frontmatter: {
      ...(result.data as SkillFrontmatter),
      name: result.data.name,
      description: result.data.description,
    },
  };
}
