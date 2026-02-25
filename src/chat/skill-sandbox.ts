import fs from "node:fs/promises";
import path from "node:path";
import { loadSkillsByName, type Skill, type SkillMetadata } from "@/chat/skills";

const MAX_SKILL_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_SKILL_FILE_CHARS = 20_000;
const DEFAULT_MAX_SKILL_LIST_ENTRIES = 200;

const ALLOWED_TOOL_ALIASES: Record<string, string[]> = {
  glob: ["list_skill_files"],
  list_files: ["list_skill_files"],
  ls: ["list_skill_files"],
  read: ["read_skill_file"],
  read_file: ["read_skill_file"]
};

function normalizePathForOutput(value: string): string {
  return value.split(path.sep).join("/");
}

function normalizeSkillName(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeAllowedToolToken(value: string): string {
  return value.trim().replace(/\(.*\)\s*$/, "").toLowerCase().replaceAll("-", "_");
}

function resolvePathWithinRoot(root: string, relativePath: string): string {
  if (!relativePath.trim()) {
    throw new Error("Path must not be empty.");
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error("Absolute paths are not allowed.");
  }

  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes the skill directory.");
  }

  return resolvedPath;
}

function toPublicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface SkillSandboxFileEntry {
  path: string;
  type: "file" | "directory";
}

export interface SkillSandboxListFilesResult {
  skillName: string;
  directory: string;
  entries: SkillSandboxFileEntry[];
  truncated: boolean;
}

export interface SkillSandboxReadFileResult {
  skillName: string;
  path: string;
  content: string;
  truncated: boolean;
}

export class SkillSandbox {
  private readonly availableSkills: SkillMetadata[];
  private readonly availableByName = new Map<string, SkillMetadata>();
  private readonly loadedSkills = new Map<string, Skill>();
  private activeSkillName: string | null = null;

  constructor(availableSkills: SkillMetadata[], preloadedSkills: Skill[] = []) {
    this.availableSkills = [...availableSkills].sort((a, b) => a.name.localeCompare(b.name));
    for (const skill of this.availableSkills) {
      this.availableByName.set(normalizeSkillName(skill.name), skill);
    }

    for (const skill of preloadedSkills) {
      const key = normalizeSkillName(skill.name);
      this.loadedSkills.set(key, skill);
      this.activeSkillName = key;
    }
  }

  getAvailableSkills(): SkillMetadata[] {
    return [...this.availableSkills];
  }

  getLoadedSkillNames(): string[] {
    return [...this.loadedSkills.values()].map((skill) => skill.name).sort((a, b) => a.localeCompare(b));
  }

  getActiveSkill(): Skill | null {
    if (!this.activeSkillName) {
      return null;
    }
    return this.loadedSkills.get(this.activeSkillName) ?? null;
  }

  async loadSkill(skillName: string): Promise<Skill | null> {
    const normalized = normalizeSkillName(skillName);
    const cached = this.loadedSkills.get(normalized);
    if (cached) {
      this.activeSkillName = normalized;
      return cached;
    }

    const meta = this.availableByName.get(normalized);
    if (!meta) {
      return null;
    }

    const [loaded] = await loadSkillsByName([meta.name], this.availableSkills);
    if (!loaded) {
      return null;
    }

    this.loadedSkills.set(normalized, loaded);
    this.activeSkillName = normalized;
    return loaded;
  }

  filterToolNames(toolNames: string[]): string[] | null {
    const activeSkill = this.getActiveSkill();
    if (!activeSkill || !activeSkill.allowedTools || activeSkill.allowedTools.length === 0) {
      return null;
    }

    const resolved = new Set<string>();
    const availableSet = new Set(toolNames);

    for (const token of activeSkill.allowedTools) {
      const normalizedToken = normalizeAllowedToolToken(token);
      if (!normalizedToken) {
        continue;
      }

      if (availableSet.has(normalizedToken)) {
        resolved.add(normalizedToken);
        continue;
      }

      const aliases = ALLOWED_TOOL_ALIASES[normalizedToken] ?? [];
      for (const alias of aliases) {
        if (availableSet.has(alias)) {
          resolved.add(alias);
        }
      }
    }

    if (availableSet.has("final_answer")) {
      resolved.add("final_answer");
    }

    return toolNames.filter((toolName) => resolved.has(toolName));
  }

  async listFiles(params: {
    skillName?: string;
    directory?: string;
    recursive?: boolean;
    maxEntries?: number;
  }): Promise<SkillSandboxListFilesResult> {
    const skill = await this.requireSkill(params.skillName);
    const directory = params.directory?.trim() || ".";
    const recursive = params.recursive ?? false;
    const maxEntries = Math.max(1, Math.min(params.maxEntries ?? DEFAULT_MAX_SKILL_LIST_ENTRIES, 1_000));

    const root = path.resolve(skill.skillPath);
    const targetDirectory = resolvePathWithinRoot(root, directory);
    const targetStats = await fs.stat(targetDirectory);
    if (!targetStats.isDirectory()) {
      throw new Error(`Path is not a directory: ${directory}`);
    }

    const entries: SkillSandboxFileEntry[] = [];
    const queue: string[] = [targetDirectory];
    let truncated = false;

    while (queue.length > 0) {
      const currentDirectory = queue.shift() as string;
      const children = await fs.readdir(currentDirectory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        const absolutePath = path.join(currentDirectory, child.name);
        const relativePath = normalizePathForOutput(path.relative(root, absolutePath));
        if (!relativePath || relativePath.startsWith("..")) {
          continue;
        }

        if (child.isDirectory()) {
          entries.push({ path: `${relativePath}/`, type: "directory" });
          if (recursive) {
            queue.push(absolutePath);
          }
        } else if (child.isFile()) {
          entries.push({ path: relativePath, type: "file" });
        }

        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
      }

      if (truncated || !recursive) {
        break;
      }
    }

    const relativeDirectory = normalizePathForOutput(path.relative(root, targetDirectory) || ".");
    return {
      skillName: skill.name,
      directory: relativeDirectory,
      entries,
      truncated
    };
  }

  async readFile(params: {
    skillName?: string;
    filePath: string;
    maxChars?: number;
  }): Promise<SkillSandboxReadFileResult> {
    const skill = await this.requireSkill(params.skillName);
    const maxChars = Math.max(1, Math.min(params.maxChars ?? DEFAULT_MAX_SKILL_FILE_CHARS, 100_000));

    const root = path.resolve(skill.skillPath);
    const targetPath = resolvePathWithinRoot(root, params.filePath);
    const stats = await fs.stat(targetPath);

    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${params.filePath}`);
    }
    if (stats.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`File exceeds ${MAX_SKILL_FILE_BYTES} bytes and cannot be loaded.`);
    }

    const raw = await fs.readFile(targetPath, "utf8");
    const truncated = raw.length > maxChars;

    return {
      skillName: skill.name,
      path: normalizePathForOutput(path.relative(root, targetPath)),
      content: truncated ? raw.slice(0, maxChars) : raw,
      truncated
    };
  }

  private async requireSkill(skillName?: string): Promise<Skill> {
    const explicit = skillName?.trim();
    if (explicit) {
      const loaded = await this.loadSkill(explicit);
      if (!loaded) {
        throw new Error(`Unknown skill: ${explicit}`);
      }
      return loaded;
    }

    const active = this.getActiveSkill();
    if (active) {
      return active;
    }

    if (this.loadedSkills.size === 1) {
      return [...this.loadedSkills.values()][0];
    }

    throw new Error("No active skill is loaded. Call load_skill first or pass skill_name explicitly.");
  }
}

export function getSkillSandbox(
  context: unknown
): { ok: true; sandbox: SkillSandbox } | { ok: false; error: string } {
  if (context instanceof SkillSandbox) {
    return { ok: true, sandbox: context };
  }

  return {
    ok: false,
    error: "Skill sandbox is unavailable in this tool execution context."
  };
}

export function toSkillSandboxToolError(error: unknown): { ok: false; error: string } {
  return {
    ok: false,
    error: toPublicErrorMessage(error)
  };
}
