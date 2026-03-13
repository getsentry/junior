import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedSkillFile } from "@/chat/skill-frontmatter";
import { parseSkillFile } from "@/chat/skill-frontmatter";
import { parsePluginManifest } from "@/chat/plugins/manifest";
import type { PluginManifest } from "@/chat/plugins/types";

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

interface SkillValidationResult {
  skillFile: string;
  skill?: ParsedSkillFile;
  errors: string[];
  warnings: string[];
}

interface PluginValidationResult {
  pluginDir: string;
  manifestPath: string;
  manifest?: PluginManifest;
  errors: string[];
  skillResults: SkillValidationResult[];
}

type Status = "ok" | "warn" | "error";

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  red: "\u001B[31m",
  cyan: "\u001B[36m",
};

function supportsColor(stream: NodeJS.WriteStream | undefined): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  return Boolean(stream?.isTTY);
}

const COLOR_ENABLED =
  supportsColor(process.stdout) || supportsColor(process.stderr);

function color(text: string, ...codes: string[]): string {
  if (!COLOR_ENABLED || codes.length === 0) {
    return text;
  }

  return `${codes.join("")}${text}${ANSI.reset}`;
}

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
): Promise<SkillValidationResult> {
  const skillFile = path.join(skillDir, "SKILL.md");
  const errors: string[] = [];
  const warnings: string[] = [];

  let raw: string;
  try {
    raw = await fs.readFile(skillFile, "utf8");
  } catch {
    errors.push(`${skillFile}: missing SKILL.md`);
    return { skillFile, errors, warnings };
  }

  const parsed = parseSkillFile(raw, path.basename(skillDir));
  if (!parsed.ok) {
    errors.push(`${skillFile}: ${parsed.error}`);
    return { skillFile, errors, warnings };
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

  return { skillFile, skill: parsed.skill, errors, warnings };
}

async function validatePluginDirectory(
  pluginDir: string,
  duplicatePluginNames: Map<string, string>,
): Promise<{
  manifestPath: string;
  manifest?: PluginManifest;
  errors: string[];
}> {
  const manifestPath = path.join(pluginDir, "plugin.yaml");

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = parsePluginManifest(raw, pluginDir);
    const firstSeen = duplicatePluginNames.get(manifest.name);
    if (firstSeen) {
      return {
        manifestPath,
        manifest,
        errors: [
          `${manifestPath}: duplicate plugin name "${manifest.name}" (already defined in ${firstSeen})`,
        ],
      };
    }
    duplicatePluginNames.set(manifest.name, manifestPath);
    return { manifestPath, manifest, errors: [] };
  } catch (error) {
    return {
      manifestPath,
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

async function collectSkillDirectories(root: string): Promise<string[]> {
  const skillDirs: string[] = [];

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return skillDirs;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      skillDirs.push(path.join(root, entry.name));
    }
  }

  return skillDirs.sort((left, right) => left.localeCompare(right));
}

function formatDisplayPath(rootDir: string, targetPath: string): string {
  const relativePath = path.relative(rootDir, targetPath);
  const displayPath =
    relativePath.length > 0 &&
    !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath)
      ? relativePath
      : targetPath;

  return displayPath.split(path.sep).join("/");
}

function formatStatus(errorCount: number, warningCount: number): Status {
  if (errorCount > 0) {
    return "error";
  }
  if (warningCount > 0) {
    return "warn";
  }
  return "ok";
}

function statusIcon(status: Status): string {
  switch (status) {
    case "ok":
      return color("✓", ANSI.green, ANSI.bold);
    case "warn":
      return color("⚠", ANSI.yellow, ANSI.bold);
    case "error":
      return color("✖", ANSI.red, ANSI.bold);
  }
}

function formatHeading(status: Status, label: string): string {
  const styledLabel =
    status === "ok"
      ? color(label, ANSI.bold)
      : status === "warn"
        ? color(label, ANSI.bold, ANSI.yellow)
        : color(label, ANSI.bold, ANSI.red);

  return `${statusIcon(status)} ${styledLabel}`;
}

function reportSkillResult(
  result: SkillValidationResult,
  io: ValidationIo,
  indent: string,
  isLast: boolean,
): void {
  const status = formatStatus(result.errors.length, result.warnings.length);
  const skillName =
    result.skill?.name ?? path.basename(path.dirname(result.skillFile));
  const branch = isLast ? "└─" : "├─";

  io.info(`${indent}${branch} ${formatHeading(status, `skill ${skillName}`)}`);
}

function reportPluginResult(
  result: PluginValidationResult,
  io: ValidationIo,
): void {
  const skillErrorCount = result.skillResults.reduce(
    (count, skillResult) => count + skillResult.errors.length,
    0,
  );
  const skillWarningCount = result.skillResults.reduce(
    (count, skillResult) => count + skillResult.warnings.length,
    0,
  );
  const status = formatStatus(
    result.errors.length + skillErrorCount,
    skillWarningCount,
  );
  const pluginName = result.manifest?.name ?? path.basename(result.pluginDir);

  io.info(formatHeading(status, `plugin ${pluginName}`));
  for (const [index, skillResult] of result.skillResults.entries()) {
    reportSkillResult(
      skillResult,
      io,
      "  ",
      index === result.skillResults.length - 1,
    );
  }
}

function reportAppSkills(
  skillResults: SkillValidationResult[],
  io: ValidationIo,
): void {
  const errorCount = skillResults.reduce(
    (count, skillResult) => count + skillResult.errors.length,
    0,
  );
  const warningCount = skillResults.reduce(
    (count, skillResult) => count + skillResult.warnings.length,
    0,
  );
  const status = formatStatus(errorCount, warningCount);

  io.info(formatHeading(status, "app skills"));
  for (const [index, skillResult] of skillResults.entries()) {
    reportSkillResult(skillResult, io, "  ", index === skillResults.length - 1);
  }
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
  const appSkillsRoot = contentRoot(resolvedRoot, "skills");
  const appSkillDirs = await collectSkillDirectories(appSkillsRoot);
  const pluginSkillDirs = new Map<string, string[]>();
  for (const pluginDir of pluginDirs) {
    pluginSkillDirs.set(
      pluginDir,
      await collectSkillDirectories(path.join(pluginDir, "skills")),
    );
  }

  const skillDirs = [
    ...appSkillDirs,
    ...pluginDirs.flatMap((pluginDir) => pluginSkillDirs.get(pluginDir) ?? []),
  ].sort((left, right) => left.localeCompare(right));
  const duplicateSkillNames = new Map<string, string>();
  const duplicatePluginNames = new Map<string, string>();
  const warnings: string[] = [];
  const errors: string[] = [];
  const pluginResults: PluginValidationResult[] = [];
  const skillResultsByDir = new Map<string, SkillValidationResult>();

  for (const pluginDir of pluginDirs) {
    const result = await validatePluginDirectory(
      pluginDir,
      duplicatePluginNames,
    );
    pluginResults.push({
      pluginDir,
      manifestPath: result.manifestPath,
      ...(result.manifest ? { manifest: result.manifest } : {}),
      errors: result.errors,
      skillResults: [],
    });
    errors.push(...result.errors);
  }

  for (const skillDir of skillDirs) {
    const result = await validateSkillDirectory(skillDir, duplicateSkillNames);
    skillResultsByDir.set(skillDir, result);
    warnings.push(...result.warnings);
    errors.push(...result.errors);
  }

  for (const pluginResult of pluginResults) {
    pluginResult.skillResults = (
      pluginSkillDirs.get(pluginResult.pluginDir) ?? []
    )
      .map((skillDir) => skillResultsByDir.get(skillDir))
      .filter((result): result is SkillValidationResult => Boolean(result));
  }

  const appSkillResults = appSkillDirs
    .map((skillDir) => skillResultsByDir.get(skillDir))
    .filter((result): result is SkillValidationResult => Boolean(result));

  io.info(
    `${color("Checking", ANSI.bold, ANSI.cyan)} ${color(
      formatDisplayPath(resolvedRoot, resolvedRoot),
      ANSI.dim,
    )}`,
  );
  for (const pluginResult of pluginResults) {
    reportPluginResult(pluginResult, io);
  }
  if (appSkillResults.length > 0) {
    reportAppSkills(appSkillResults, io);
  }

  for (const warning of warnings) {
    io.warn(`${statusIcon("warn")} warning: ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      io.error(`${statusIcon("error")} error: ${error}`);
    }
    throw new Error(
      `Validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}, ${pluginDirs.length} plugin manifest${pluginDirs.length === 1 ? "" : "s"}, ${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} checked).`,
    );
  }

  io.info(
    `${formatHeading("ok", `Validation passed (${pluginDirs.length} plugin manifest${pluginDirs.length === 1 ? "" : "s"}, ${skillDirs.length} skill director${skillDirs.length === 1 ? "y" : "ies"} checked).`)}`,
  );
}
