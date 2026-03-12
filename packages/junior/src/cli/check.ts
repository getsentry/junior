import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parsePluginManifest } from "@/chat/plugins/manifest";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const CAPABILITY_TOKEN_RE = /^[a-z0-9]+(?:\.[a-z0-9-]+)+$/;
const MAX_NAME_LENGTH = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

export interface ValidationIo {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: ValidationIo = {
  info: console.log,
  warn: console.warn,
  error: console.error
};

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveContentRoots(rootDir: string, subdir: "skills" | "plugins"): string[] {
  const canonical = path.resolve(rootDir, "app", subdir);
  const legacy = path.resolve(rootDir, subdir);
  if (canonical === legacy) {
    return [canonical];
  }
  return unique([canonical, legacy]);
}

async function pathIsDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(targetPath: string): Promise<boolean> {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

function parseFrontmatter(raw: string): { error: string | null; data: Record<string, unknown> | null } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { error: "missing YAML frontmatter", data: null };
  }

  try {
    const parsed = parseYaml(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "frontmatter must be a YAML object", data: null };
    }
    return { error: null, data: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      error: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      data: null
    };
  }
}

function validateSkillName(name: string): string | null {
  if (!name) return "name must not be empty";
  if (name.length > MAX_NAME_LENGTH) return `name must be <= ${MAX_NAME_LENGTH} characters`;
  if (!SKILL_NAME_RE.test(name)) return "name must contain only lowercase letters, digits, and hyphens";
  if (name.startsWith("-") || name.endsWith("-")) return "name must not start or end with a hyphen";
  if (name.includes("--")) return "name must not contain consecutive hyphens";
  return null;
}

async function validateSkillDirectory(
  skillDir: string,
  duplicateNames: Map<string, string>
): Promise<{ errors: string[]; warnings: string[] }> {
  const skillFile = path.join(skillDir, "SKILL.md");
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: string;
  try {
    raw = await fs.readFile(skillFile, "utf8");
  } catch {
    errors.push(`${skillFile}: missing SKILL.md`);
    return { errors, warnings };
  }

  const frontmatter = parseFrontmatter(raw);
  if (frontmatter.error || !frontmatter.data) {
    errors.push(`${skillFile}: ${frontmatter.error}`);
    return { errors, warnings };
  }

  const name = frontmatter.data.name;
  const description = frontmatter.data.description;
  const expectedName = path.basename(skillDir);

  if (typeof name !== "string") {
    errors.push(`${skillFile}: frontmatter field "name" must be a string`);
  } else {
    const nameError = validateSkillName(name);
    if (nameError) {
      errors.push(`${skillFile}: ${nameError}`);
    }
    if (name !== expectedName) {
      errors.push(`${skillFile}: name "${name}" must match directory "${expectedName}"`);
    }
    const firstSeen = duplicateNames.get(name);
    if (firstSeen) {
      errors.push(`${skillFile}: duplicate skill name "${name}" (already defined in ${firstSeen})`);
    } else {
      duplicateNames.set(name, skillFile);
    }
  }

  if (typeof description !== "string") {
    errors.push(`${skillFile}: frontmatter field "description" must be a string`);
  } else {
    if (!description.trim()) {
      errors.push(`${skillFile}: description must not be empty`);
    }
    if (description.length > SKILL_DESCRIPTION_MAX) {
      errors.push(`${skillFile}: description exceeds ${SKILL_DESCRIPTION_MAX} characters`);
    }
    if (description.includes("<") || description.includes(">")) {
      errors.push(`${skillFile}: description must not contain "<" or ">"`);
    }
  }

  if ("metadata" in frontmatter.data) {
    const metadata = frontmatter.data.metadata;
    if (typeof metadata !== "object" || !metadata || Array.isArray(metadata)) {
      errors.push(`${skillFile}: frontmatter field "metadata" must be an object when present`);
    }
  }
  if ("compatibility" in frontmatter.data) {
    const compatibility = frontmatter.data.compatibility;
    if (typeof compatibility !== "string") {
      errors.push(`${skillFile}: frontmatter field "compatibility" must be a string when present`);
    } else if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      errors.push(`${skillFile}: compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters`);
    }
  }
  if ("license" in frontmatter.data && typeof frontmatter.data.license !== "string") {
    errors.push(`${skillFile}: frontmatter field "license" must be a string when present`);
  }
  if ("allowed-tools" in frontmatter.data && typeof frontmatter.data["allowed-tools"] !== "string") {
    errors.push(`${skillFile}: frontmatter field "allowed-tools" must be a string when present`);
  }
  if ("requires-capabilities" in frontmatter.data) {
    const capabilities = frontmatter.data["requires-capabilities"];
    if (typeof capabilities !== "string") {
      errors.push(`${skillFile}: frontmatter field "requires-capabilities" must be a string when present`);
    } else {
      const tokens = capabilities
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      for (const token of tokens) {
        if (!CAPABILITY_TOKEN_RE.test(token)) {
          errors.push(
            `${skillFile}: invalid requires-capabilities token "${token}" (expected dotted lowercase token such as github.issues.write)`
          );
        }
      }
    }
  }

  if (!raw.replace(FRONTMATTER_RE, "").trim()) {
    warnings.push(`${skillFile}: no skill instructions after frontmatter`);
  }

  return { errors, warnings };
}

async function validatePluginDirectory(
  pluginDir: string,
  duplicatePluginNames: Map<string, string>
): Promise<{ errors: string[] }> {
  const manifestPath = path.join(pluginDir, "plugin.yaml");

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = parsePluginManifest(raw, pluginDir);
    const firstSeen = duplicatePluginNames.get(manifest.name);
    if (firstSeen) {
      return {
        errors: [`${manifestPath}: duplicate plugin name "${manifest.name}" (already defined in ${firstSeen})`]
      };
    }
    duplicatePluginNames.set(manifest.name, manifestPath);
    return { errors: [] };
  } catch (error) {
    return {
      errors: [`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`]
    };
  }
}

async function collectPluginDirectories(rootDir: string): Promise<string[]> {
  const pluginDirs: string[] = [];
  for (const pluginsRoot of resolveContentRoots(rootDir, "plugins")) {
    let entries;
    try {
      entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const pluginDir = path.join(pluginsRoot, entry.name);
      if (await pathIsFile(path.join(pluginDir, "plugin.yaml"))) {
        pluginDirs.push(pluginDir);
      }
    }
  }

  return unique(pluginDirs).sort((left, right) => left.localeCompare(right));
}

async function collectSkillDirectories(rootDir: string, pluginDirs: string[]): Promise<string[]> {
  const roots = [...resolveContentRoots(rootDir, "skills"), ...pluginDirs.map((pluginDir) => path.join(pluginDir, "skills"))];
  const skillDirs: string[] = [];

  for (const root of unique(roots)) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        skillDirs.push(path.join(root, entry.name));
      }
    }
  }

  return unique(skillDirs).sort((left, right) => left.localeCompare(right));
}

export async function runCheck(rootDir: string = process.cwd(), io: ValidationIo = DEFAULT_IO): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  if (!(await pathIsDirectory(resolvedRoot))) {
    throw new Error(`validation root does not exist or is not a directory: ${resolvedRoot}`);
  }

  const pluginDirs = await collectPluginDirectories(resolvedRoot);
  const skillDirs = await collectSkillDirectories(resolvedRoot, pluginDirs);
  const duplicateSkillNames = new Map<string, string>();
  const duplicatePluginNames = new Map<string, string>();
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const pluginDir of pluginDirs) {
    const result = await validatePluginDirectory(pluginDir, duplicatePluginNames);
    errors.push(...result.errors);
  }

  for (const skillDir of skillDirs) {
    const result = await validateSkillDirectory(skillDir, duplicateSkillNames);
    warnings.push(...result.warnings);
    errors.push(...result.errors);
  }

  for (const warning of warnings) {
    io.warn(`warning: ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      io.error(`error: ${error}`);
    }
    throw new Error(
      `Validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}, ${pluginDirs.length} plugin manifest${pluginDirs.length === 1 ? "" : "s"}, ${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} checked).`
    );
  }

  io.info(
    `Validation passed (${pluginDirs.length} plugin manifest${pluginDirs.length === 1 ? "" : "s"}, ${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} checked).`
  );
}
