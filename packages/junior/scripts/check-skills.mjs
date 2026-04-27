import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const SKILL_NAME_RE = /^[a-z0-9-]+$/;
const MAX_NAME_LENGTH = 64;
const SKILL_DESCRIPTION_MAX = 1024;
const MAX_COMPATIBILITY_LENGTH = 500;

function unique(values) {
  return [...new Set(values)];
}

function resolveContentRoots(subdir) {
  const canonical = path.resolve(process.cwd(), "app", subdir);
  const legacy = path.resolve(process.cwd(), subdir);
  if (canonical === legacy) {
    return [canonical];
  }

  return unique([canonical, legacy]);
}

async function pathIsDirectory(targetPath) {
  try {
    return (await fs.stat(targetPath)).isDirectory();
  } catch {
    return false;
  }
}

async function pathIsFile(targetPath) {
  try {
    return (await fs.stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function readRootPackageJson(cwd) {
  const rootPackageJsonPath = path.join(cwd, "package.json");
  try {
    const raw = await fs.readFile(rootPackageJsonPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readInstalledDependencyNames(cwd) {
  const rootPackageJson = await readRootPackageJson(cwd);
  if (!rootPackageJson) {
    return [];
  }

  const dependencies = Object.keys(rootPackageJson.dependencies ?? {});
  const optionalDependencies = Object.keys(
    rootPackageJson.optionalDependencies ?? {},
  );
  return unique([...dependencies, ...optionalDependencies]).sort(
    (left, right) => left.localeCompare(right),
  );
}

function packageInstallDir(cwd, packageName) {
  return path.join(cwd, "node_modules", ...packageName.split("/"));
}

async function resolvePackagedPluginSkillRoots() {
  const cwd = process.cwd();
  const dependencies = await readInstalledDependencyNames(cwd);
  const roots = [];

  for (const dependency of dependencies) {
    const packageDir = packageInstallDir(cwd, dependency);
    const hasRootPluginManifest = await pathIsFile(
      path.join(packageDir, "plugin.yaml"),
    );
    const hasPluginsDir = await pathIsDirectory(
      path.join(packageDir, "plugins"),
    );
    const hasSkillsDir = await pathIsDirectory(path.join(packageDir, "skills"));
    if (!hasRootPluginManifest && !hasPluginsDir && !hasSkillsDir) {
      continue;
    }

    if (hasSkillsDir) {
      roots.push(path.join(packageDir, "skills"));
    }

    if (!hasPluginsDir) {
      continue;
    }

    let pluginEntries;
    try {
      pluginEntries = await fs.readdir(path.join(packageDir, "plugins"), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }

    for (const entry of pluginEntries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const pluginDir = path.join(packageDir, "plugins", entry.name);
      if (!(await pathIsFile(path.join(pluginDir, "plugin.yaml")))) {
        continue;
      }

      roots.push(path.join(pluginDir, "skills"));
    }
  }

  return unique(roots);
}

async function resolvePluginSkillRoots() {
  const localRoots = [];
  for (const pluginsRoot of resolveContentRoots("plugins")) {
    let entries;
    try {
      entries = await fs.readdir(pluginsRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(pluginsRoot, entry.name, "plugin.yaml");
      try {
        await fs.access(manifestPath);
        localRoots.push(path.join(pluginsRoot, entry.name, "skills"));
      } catch {
        continue;
      }
    }
  }

  const packagedRoots = await resolvePackagedPluginSkillRoots();
  return unique([...localRoots, ...packagedRoots]);
}

function resolveSkillRoots() {
  const envRoots = (process.env.SKILL_DIRS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => path.resolve(value));

  return unique([...envRoots, ...resolveContentRoots("skills")]);
}

function parseFrontmatter(raw) {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { error: "missing YAML frontmatter", data: null };
  }

  try {
    const parsed = parseYaml(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "frontmatter must be a YAML object", data: null };
    }
    return { error: null, data: parsed };
  } catch (error) {
    return {
      error: `invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      data: null,
    };
  }
}

function validateSkillName(name) {
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

async function validateSkillDirectory(skillDir, duplicateNames) {
  const skillFile = path.join(skillDir, "SKILL.md");
  const errors = [];
  const warnings = [];

  let raw;
  try {
    raw = await fs.readFile(skillFile, "utf8");
  } catch {
    errors.push(`${skillFile}: missing SKILL.md`);
    return { errors, warnings, name: null };
  }

  const frontmatter = parseFrontmatter(raw);
  if (frontmatter.error || !frontmatter.data) {
    errors.push(`${skillFile}: ${frontmatter.error}`);
    return { errors, warnings, name: null };
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
      errors.push(
        `${skillFile}: name "${name}" must match directory "${expectedName}"`,
      );
    }
    const firstSeen = duplicateNames.get(name);
    if (firstSeen) {
      errors.push(
        `${skillFile}: duplicate skill name "${name}" (already defined in ${firstSeen})`,
      );
    } else {
      duplicateNames.set(name, skillFile);
    }
  }

  if (typeof description !== "string") {
    errors.push(
      `${skillFile}: frontmatter field "description" must be a string`,
    );
  } else {
    if (!description.trim()) {
      errors.push(`${skillFile}: description must not be empty`);
    }
    if (description.length > SKILL_DESCRIPTION_MAX) {
      errors.push(
        `${skillFile}: description exceeds ${SKILL_DESCRIPTION_MAX} characters`,
      );
    }
    if (description.includes("<") || description.includes(">")) {
      errors.push(`${skillFile}: description must not contain "<" or ">"`);
    }
  }

  if ("metadata" in frontmatter.data) {
    const metadata = frontmatter.data.metadata;
    if (typeof metadata !== "object" || !metadata || Array.isArray(metadata)) {
      errors.push(
        `${skillFile}: frontmatter field "metadata" must be an object when present`,
      );
    }
  }
  if ("compatibility" in frontmatter.data) {
    const compatibility = frontmatter.data.compatibility;
    if (typeof compatibility !== "string") {
      errors.push(
        `${skillFile}: frontmatter field "compatibility" must be a string when present`,
      );
    } else if (compatibility.length > MAX_COMPATIBILITY_LENGTH) {
      errors.push(
        `${skillFile}: compatibility exceeds ${MAX_COMPATIBILITY_LENGTH} characters`,
      );
    }
  }
  if (
    "license" in frontmatter.data &&
    typeof frontmatter.data.license !== "string"
  ) {
    errors.push(
      `${skillFile}: frontmatter field "license" must be a string when present`,
    );
  }
  if (
    "allowed-tools" in frontmatter.data &&
    typeof frontmatter.data["allowed-tools"] !== "string"
  ) {
    errors.push(
      `${skillFile}: frontmatter field "allowed-tools" must be a string when present`,
    );
  }
  if ("requires-capabilities" in frontmatter.data) {
    errors.push(
      `${skillFile}: frontmatter field "requires-capabilities" is no longer supported; plugin-backed skills inherit credentials from their plugin`,
    );
  }

  if (!raw.replace(FRONTMATTER_RE, "").trim()) {
    warnings.push(`${skillFile}: no skill instructions after frontmatter`);
  }
  const body = raw.replace(FRONTMATTER_RE, "");
  if (
    /\b(?:searchTools|useTool|callMcpTool|available_tools)\b|<active-mcp-tools>/.test(
      body,
    )
  ) {
    errors.push(
      `${skillFile}: skill instructions must not hardcode harness tool-discovery or MCP dispatcher mechanics`,
    );
  }

  return { errors, warnings, name: typeof name === "string" ? name : null };
}

async function main() {
  const pluginRoots = await resolvePluginSkillRoots();
  const roots = [...resolveSkillRoots(), ...pluginRoots];
  const errors = [];
  const warnings = [];
  const duplicateNames = new Map();
  let checked = 0;

  for (const root of roots) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(root, entry.name);
      const result = await validateSkillDirectory(skillDir, duplicateNames);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      checked += 1;
    }
  }

  for (const warning of warnings) {
    console.warn(`warning: ${warning}`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(`error: ${error}`);
    }
    console.error(
      `\nSkill validation failed (${errors.length} error${errors.length === 1 ? "" : "s"}).`,
    );
    process.exit(1);
  }

  console.log(
    `Skill validation passed (${checked} skill director${checked === 1 ? "y" : "ies"} checked).`,
  );
}

await main();
