import fs from "node:fs/promises";
import path from "node:path";
import type { ParsedSkillFile } from "@/chat/skills";
import { parseSkillFile } from "@/chat/skills";
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
  packageName?: string;
  manifest?: PluginManifest;
  errors: string[];
  skillResults: SkillValidationResult[];
}

interface PackagedPluginDirectory {
  pluginDir: string;
  packageName: string;
}

interface PackagedSkillRoot {
  root: string;
  packageName: string;
}

interface DeclaredPackage {
  name: string;
  spec: string;
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

async function readJsonFile<T>(targetPath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

interface PackageJson {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  version?: string;
}

async function readRootPackageJson(
  rootDir: string,
): Promise<PackageJson | undefined> {
  return await readJsonFile<PackageJson>(path.join(rootDir, "package.json"));
}

function packageInstallDir(rootDir: string, packageName: string): string {
  return path.join(rootDir, "node_modules", ...packageName.split("/"));
}

function declaredPackages(pkg: PackageJson | undefined): DeclaredPackage[] {
  if (!pkg) {
    return [];
  }
  const packages = new Map<string, string>();
  for (const deps of [
    pkg.dependencies,
    pkg.optionalDependencies,
    pkg.devDependencies,
  ]) {
    for (const [name, spec] of Object.entries(deps ?? {})) {
      if (!packages.has(name)) {
        packages.set(name, spec);
      }
    }
  }
  return [...packages.entries()]
    .map(([name, spec]) => ({ name, spec }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function readInstalledPackageVersion(
  rootDir: string,
  packageName: string,
): Promise<string | undefined> {
  return (
    await readJsonFile<PackageJson>(
      path.join(packageInstallDir(rootDir, packageName), "package.json"),
    )
  )?.version;
}

async function packageHasPluginContent(
  rootDir: string,
  packageName: string,
): Promise<boolean> {
  const packageDir = packageInstallDir(rootDir, packageName);
  return (
    (await pathIsFile(path.join(packageDir, "plugin.yaml"))) ||
    (await pathIsDirectory(path.join(packageDir, "plugins"))) ||
    (await pathIsDirectory(path.join(packageDir, "skills")))
  );
}

function comparableVersion(version: string | undefined): string | undefined {
  return version?.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
}

async function collectPackageWarnings(
  rootDir: string,
  packages: DeclaredPackage[],
): Promise<string[]> {
  const warnings: string[] = [];
  const packageSpecByName = new Map(
    packages.map((declaredPackage) => [
      declaredPackage.name,
      declaredPackage.spec,
    ]),
  );
  const coreVersion = comparableVersion(
    (await readInstalledPackageVersion(rootDir, "@sentry/junior")) ??
      packageSpecByName.get("@sentry/junior"),
  );
  if (!coreVersion) {
    return warnings;
  }

  for (const declaredPackage of packages) {
    if (!declaredPackage.name.startsWith("@sentry/junior-")) {
      continue;
    }
    if (!(await packageHasPluginContent(rootDir, declaredPackage.name))) {
      continue;
    }
    const pluginVersion = comparableVersion(
      (await readInstalledPackageVersion(rootDir, declaredPackage.name)) ??
        declaredPackage.spec,
    );
    if (pluginVersion && pluginVersion !== coreVersion) {
      warnings.push(
        `${path.join(rootDir, "package.json")}: ${declaredPackage.name} version ${pluginVersion} does not match @sentry/junior version ${coreVersion}`,
      );
    }
  }

  return warnings;
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
  if (
    /\b(?:searchTools|searchMcpTools|useTool|callMcpTool|available_tools)\b|<active-mcp-(?:tools|catalogs)>/.test(
      parsed.skill.body,
    )
  ) {
    errors.push(
      `${skillFile}: skill instructions must not hardcode harness tool-discovery or MCP dispatcher mechanics`,
    );
  }

  return { skillFile, skill: parsed.skill, errors, warnings };
}

async function validatePluginDirectory(
  pluginDir: string,
  duplicatePluginNames: Map<string, string>,
  duplicateProviderDomains: Map<string, string>,
): Promise<{
  manifestPath: string;
  manifest?: PluginManifest;
  errors: string[];
}> {
  const manifestPath = path.join(pluginDir, "plugin.yaml");

  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    const manifest = parsePluginManifest(raw, pluginDir);
    const errors: string[] = [];
    const firstSeen = duplicatePluginNames.get(manifest.name);
    if (firstSeen) {
      errors.push(
        `${manifestPath}: duplicate plugin name "${manifest.name}" (already defined in ${firstSeen})`,
      );
    }
    const domains = [
      ...new Set([
        ...(manifest.credentials?.domains ?? []),
        ...(manifest.domains ?? []),
      ]),
    ];
    for (const domain of domains) {
      const firstDomainSeen = duplicateProviderDomains.get(domain);
      if (firstDomainSeen) {
        errors.push(
          `${manifestPath}: duplicate provider domain "${domain}" (already defined in ${firstDomainSeen})`,
        );
      }
    }
    if (errors.length > 0) {
      return { manifestPath, manifest, errors };
    }
    duplicatePluginNames.set(manifest.name, manifestPath);
    for (const domain of domains) {
      duplicateProviderDomains.set(domain, manifestPath);
    }
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

async function collectPackagedContent(
  rootDir: string,
  packages: DeclaredPackage[],
): Promise<{
  pluginDirs: PackagedPluginDirectory[];
  skillRoots: PackagedSkillRoot[];
}> {
  const pluginDirs: PackagedPluginDirectory[] = [];
  const skillRoots: PackagedSkillRoot[] = [];

  for (const declaredPackage of packages) {
    const packageDir = packageInstallDir(rootDir, declaredPackage.name);
    if (!(await pathIsDirectory(packageDir))) {
      continue;
    }

    const rootManifestPath = path.join(packageDir, "plugin.yaml");
    const hasRootManifest = await pathIsFile(rootManifestPath);
    const packageSkillsRoot = path.join(packageDir, "skills");

    if (hasRootManifest) {
      pluginDirs.push({
        pluginDir: packageDir,
        packageName: declaredPackage.name,
      });
    } else if (await pathIsDirectory(packageSkillsRoot)) {
      skillRoots.push({
        root: packageSkillsRoot,
        packageName: declaredPackage.name,
      });
    }

    const nestedPluginsRoot = path.join(packageDir, "plugins");
    let nestedEntries;
    try {
      nestedEntries = await fs.readdir(nestedPluginsRoot, {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of nestedEntries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const pluginDir = path.join(nestedPluginsRoot, entry.name);
      if (await pathIsFile(path.join(pluginDir, "plugin.yaml"))) {
        pluginDirs.push({
          pluginDir,
          packageName: declaredPackage.name,
        });
      }
    }
  }

  return {
    pluginDirs: pluginDirs.sort((left, right) =>
      `${left.packageName}:${left.pluginDir}`.localeCompare(
        `${right.packageName}:${right.pluginDir}`,
      ),
    ),
    skillRoots: skillRoots.sort((left, right) =>
      `${left.packageName}:${left.root}`.localeCompare(
        `${right.packageName}:${right.root}`,
      ),
    ),
  };
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
  const label = result.packageName
    ? `packaged plugin ${pluginName} (${result.packageName})`
    : `plugin ${pluginName}`;

  io.info(formatHeading(status, label));
  for (const [index, skillResult] of result.skillResults.entries()) {
    reportSkillResult(
      skillResult,
      io,
      "  ",
      index === result.skillResults.length - 1,
    );
  }
}

function reportSkillGroup(
  label: string,
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

  io.info(formatHeading(status, label));
  for (const [index, skillResult] of skillResults.entries()) {
    reportSkillResult(skillResult, io, "  ", index === skillResults.length - 1);
  }
}

function reportAppSkills(
  skillResults: SkillValidationResult[],
  io: ValidationIo,
): void {
  reportSkillGroup("app skills", skillResults, io);
}

interface AppFileValidationResult {
  errors: string[];
  warnings: string[];
}

async function validateAppFiles(
  appDir: string,
): Promise<AppFileValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (await pathIsFile(path.join(appDir, "ABOUT.md"))) {
    errors.push(
      `${path.join(appDir, "ABOUT.md")}: ABOUT.md is no longer supported. Rename to WORLD.md (operational context) and DESCRIPTION.md (user-facing description).`,
    );
  }

  if (!(await pathIsFile(path.join(appDir, "SOUL.md")))) {
    warnings.push(`${path.join(appDir, "SOUL.md")}: missing SOUL.md`);
  }

  if (!(await pathIsFile(path.join(appDir, "WORLD.md")))) {
    warnings.push(`${path.join(appDir, "WORLD.md")}: missing WORLD.md`);
  }

  if (!(await pathIsFile(path.join(appDir, "DESCRIPTION.md")))) {
    warnings.push(
      `${path.join(appDir, "DESCRIPTION.md")}: missing DESCRIPTION.md`,
    );
  }

  return { errors, warnings };
}

async function hasJuniorAppMarkers(appDir: string): Promise<boolean> {
  for (const fileName of [
    "SOUL.md",
    "WORLD.md",
    "DESCRIPTION.md",
    "ABOUT.md",
  ]) {
    if (await pathIsFile(path.join(appDir, fileName))) {
      return true;
    }
  }

  for (const dirName of ["skills", "plugins"]) {
    if (await pathIsDirectory(path.join(appDir, dirName))) {
      return true;
    }
  }

  return false;
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

  const rootPackageJson = await readRootPackageJson(resolvedRoot);
  const packages = declaredPackages(rootPackageJson);
  const packageWarnings = await collectPackageWarnings(resolvedRoot, packages);
  const packagedContent = await collectPackagedContent(resolvedRoot, packages);
  const appPluginDirs = await collectPluginDirectories(resolvedRoot);
  const packagedPluginDirs = packagedContent.pluginDirs;
  const pluginDirs = [
    ...appPluginDirs.map((pluginDir) => ({
      pluginDir,
      packageName: undefined,
    })),
    ...packagedPluginDirs,
  ];
  const appSkillsRoot = contentRoot(resolvedRoot, "skills");
  const appSkillDirs = await collectSkillDirectories(appSkillsRoot);
  const pluginSkillDirs = new Map<string, string[]>();
  for (const { pluginDir } of pluginDirs) {
    pluginSkillDirs.set(
      pluginDir,
      await collectSkillDirectories(path.join(pluginDir, "skills")),
    );
  }
  const packagedSkillDirsByPackage = new Map<string, string[]>();
  for (const skillRoot of packagedContent.skillRoots) {
    packagedSkillDirsByPackage.set(
      skillRoot.packageName,
      await collectSkillDirectories(skillRoot.root),
    );
  }
  const packagedStandaloneSkillDirs = [
    ...packagedSkillDirsByPackage.values(),
  ].flat();

  const appAndLocalPluginSkillDirs = [
    ...appSkillDirs,
    ...appPluginDirs.flatMap(
      (pluginDir) => pluginSkillDirs.get(pluginDir) ?? [],
    ),
  ].sort((left, right) => left.localeCompare(right));
  const packagedSkillDirs = [
    ...packagedPluginDirs.flatMap(
      ({ pluginDir }) => pluginSkillDirs.get(pluginDir) ?? [],
    ),
    ...packagedStandaloneSkillDirs,
  ].sort((left, right) => left.localeCompare(right));
  const skillDirs = [...appAndLocalPluginSkillDirs, ...packagedSkillDirs].sort(
    (left, right) => left.localeCompare(right),
  );
  const duplicateSkillNames = new Map<string, string>();
  const duplicatePluginNames = new Map<string, string>();
  const duplicateProviderDomains = new Map<string, string>();
  const duplicatePackagedSkillNames = new Map<string, string>();
  const duplicatePackagedPluginNames = new Map<string, string>();
  const duplicatePackagedProviderDomains = new Map<string, string>();
  const warnings: string[] = [];
  const errors: string[] = [];
  const pluginResults: PluginValidationResult[] = [];
  const skillResultsByDir = new Map<string, SkillValidationResult>();
  warnings.push(...packageWarnings);

  for (const { pluginDir, packageName } of pluginDirs) {
    const pluginNameMap = packageName
      ? duplicatePackagedPluginNames
      : duplicatePluginNames;
    const providerDomainMap = packageName
      ? duplicatePackagedProviderDomains
      : duplicateProviderDomains;
    const result = await validatePluginDirectory(
      pluginDir,
      pluginNameMap,
      providerDomainMap,
    );
    pluginResults.push({
      pluginDir,
      manifestPath: result.manifestPath,
      ...(packageName ? { packageName } : {}),
      ...(result.manifest ? { manifest: result.manifest } : {}),
      errors: result.errors,
      skillResults: [],
    });
    errors.push(...result.errors);
  }

  for (const skillDir of appAndLocalPluginSkillDirs) {
    const result = await validateSkillDirectory(skillDir, duplicateSkillNames);
    skillResultsByDir.set(skillDir, result);
    warnings.push(...result.warnings);
    errors.push(...result.errors);
  }
  for (const skillDir of packagedSkillDirs) {
    const result = await validateSkillDirectory(
      skillDir,
      duplicatePackagedSkillNames,
    );
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
  const packagedStandaloneSkillResultsByPackage = new Map<
    string,
    SkillValidationResult[]
  >();
  for (const [packageName, packageSkillDirs] of packagedSkillDirsByPackage) {
    const packageSkillResults = packageSkillDirs
      .map((skillDir) => skillResultsByDir.get(skillDir))
      .filter((result): result is SkillValidationResult => Boolean(result));
    if (packageSkillResults.length > 0) {
      packagedStandaloneSkillResultsByPackage.set(
        packageName,
        packageSkillResults,
      );
    }
  }

  const appDir = path.resolve(resolvedRoot, "app");
  let appFileResult: AppFileValidationResult = {
    errors: [],
    warnings: [],
  };
  const shouldValidateAppFiles =
    (await pathIsDirectory(appDir)) && (await hasJuniorAppMarkers(appDir));
  if (shouldValidateAppFiles) {
    appFileResult = await validateAppFiles(appDir);
    warnings.push(...appFileResult.warnings);
    errors.push(...appFileResult.errors);
  }

  io.info(
    `${color("Checking", ANSI.bold, ANSI.cyan)} ${color(
      formatDisplayPath(resolvedRoot, resolvedRoot),
      ANSI.dim,
    )}`,
  );

  if (shouldValidateAppFiles) {
    const appFileStatus = formatStatus(
      appFileResult.errors.length,
      appFileResult.warnings.length,
    );
    io.info(formatHeading(appFileStatus, "app files"));
  }

  for (const pluginResult of pluginResults) {
    reportPluginResult(pluginResult, io);
  }
  for (const [
    packageName,
    packageSkillResults,
  ] of packagedStandaloneSkillResultsByPackage) {
    reportSkillGroup(
      `packaged skills (${packageName})`,
      packageSkillResults,
      io,
    );
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
