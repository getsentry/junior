import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillFile } from "@/chat/skill-frontmatter";
import { parsePluginManifest } from "@/chat/plugins/manifest";

export interface ValidationIo {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

const DEFAULT_IO: ValidationIo = {
  info: console.log,
  warn: console.warn,
  error: console.error,
};

function contentRoot(rootDir: string, subdir: "skills" | "plugins"): string {
  return path.resolve(rootDir, "app", subdir);
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

async function validateSkillDirectory(
  skillDir: string,
  duplicateNames: Map<string, string>,
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

  const parsed = parseSkillFile(raw, path.basename(skillDir));
  if (!parsed.ok) {
    errors.push(`${skillFile}: ${parsed.error}`);
    return { errors, warnings };
  }

  const name = parsed.skill.name;
  const firstSeen = duplicateNames.get(name);
  if (firstSeen) {
    errors.push(
      `${skillFile}: duplicate skill name "${name}" (already defined in ${firstSeen})`,
    );
  } else {
    duplicateNames.set(name, skillFile);
  }

  if (!parsed.skill.body) {
    warnings.push(`${skillFile}: no skill instructions after frontmatter`);
  }

  return { errors, warnings };
}

async function validatePluginDirectory(
  pluginDir: string,
  duplicatePluginNames: Map<string, string>,
): Promise<{ errors: string[] }> {
  const manifestPath = path.join(pluginDir, "plugin.yaml");

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = parsePluginManifest(raw, pluginDir);
    const firstSeen = duplicatePluginNames.get(manifest.name);
    if (firstSeen) {
      return {
        errors: [
          `${manifestPath}: duplicate plugin name "${manifest.name}" (already defined in ${firstSeen})`,
        ],
      };
    }
    duplicatePluginNames.set(manifest.name, manifestPath);
    return { errors: [] };
  } catch (error) {
    return {
      errors: [
        `${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

async function collectPluginDirectories(rootDir: string): Promise<string[]> {
  const pluginDirs: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(contentRoot(rootDir, "plugins"), {
      withFileTypes: true,
    });
  } catch {
    return pluginDirs;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const pluginDir = path.join(contentRoot(rootDir, "plugins"), entry.name);
    if (await pathIsFile(path.join(pluginDir, "plugin.yaml"))) {
      pluginDirs.push(pluginDir);
    }
  }

  return pluginDirs.sort((left, right) => left.localeCompare(right));
}

async function collectSkillDirectories(
  rootDir: string,
  pluginDirs: string[],
): Promise<string[]> {
  const roots = [
    contentRoot(rootDir, "skills"),
    ...pluginDirs.map((pluginDir) => path.join(pluginDir, "skills")),
  ];
  const skillDirs: string[] = [];

  for (const root of roots) {
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

  return skillDirs.sort((left, right) => left.localeCompare(right));
}

export async function runCheck(
  rootDir: string = process.cwd(),
  io: ValidationIo = DEFAULT_IO,
): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  if (!(await pathIsDirectory(resolvedRoot))) {
    throw new Error(
      `validation root does not exist or is not a directory: ${resolvedRoot}`,
    );
  }

  const pluginDirs = await collectPluginDirectories(resolvedRoot);
  const skillDirs = await collectSkillDirectories(resolvedRoot, pluginDirs);
  const duplicateSkillNames = new Map<string, string>();
  const duplicatePluginNames = new Map<string, string>();
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const pluginDir of pluginDirs) {
    const result = await validatePluginDirectory(
      pluginDir,
      duplicatePluginNames,
    );
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
      `Validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}, ${pluginDirs.length} plugin manifest${pluginDirs.length === 1 ? "" : "s"}, ${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} checked).`,
    );
  }

  io.info(
    `Validation passed (${pluginDirs.length} plugin manifest${pluginDirs.length === 1 ? "" : "s"}, ${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} checked).`,
  );
}
