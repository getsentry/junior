import { createHash } from "node:crypto";
import path from "node:path";
import type { PiMessage } from "@/chat/pi/messages";
import {
  SANDBOX_REPOS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import type { SandboxFileSystem } from "@/chat/sandbox/workspace";
import { parseSkillFile } from "@/chat/skills";
import { isMissingPathError } from "@/chat/tools/sandbox/file-utils";

const AGENTS_FILENAME = "AGENTS.md";
const MAX_REPOSITORY_INSTRUCTIONS_BYTES = 32 * 1024;
/** Repository skill directories, in priority order, relative to the Git root. */
const REPOSITORY_SKILL_ROOTS = [".agents/skills", ".claude/skills"];
const REPOSITORY_SKILLS_HEADER = [
  "## Repository skills",
  "",
  "These skills come from the repository, not from `<available-skills>`. `loadSkill` cannot load them.",
  "Before work that matches a skill description, read its `SKILL.md` with `readFile` and follow it.",
  "Resolve relative paths in a skill against the skill directory.",
].join("\n");

export const AGENTS_REPLACEMENT_NOTICE =
  "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
export const AGENTS_REMOVAL_NOTICE =
  "The previously provided AGENTS.md instructions no longer apply.";

/** Effective AGENTS.md instructions and repository skills, plus host-only discovery provenance. */
export interface RepositoryInstructions {
  /** Selected directory when instructions come from one repository tree. */
  directory?: string;
  fingerprint: string;
  /** Model-invocable skills found in repository skill directories. */
  skills?: RepositorySkill[];
  sources: Array<{ content: string; path: string }>;
  text: string;
}

/** One repository-owned skill that the model can read from the sandbox. */
export interface RepositorySkill {
  description: string;
  name: string;
  /** Absolute sandbox path of the skill's SKILL.md file. */
  path: string;
}

/** Latest model-visible AGENTS.md state parsed from trusted runtime context. */
export type VisibleAgentsInstructions =
  | { active: false }
  | { active: true; directory?: string; text: string };

async function pathExists(
  fs: SandboxFileSystem,
  target: string,
): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function directoryExists(
  fs: SandboxFileSystem,
  target: string,
): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function findGitRoot(
  fs: SandboxFileSystem,
  cwd: string,
): Promise<string | undefined> {
  let current = cwd;
  for (;;) {
    if (await pathExists(fs, path.posix.join(current, ".git"))) {
      return current;
    }
    if (current === SANDBOX_WORKSPACE_ROOT) {
      return undefined;
    }
    const parent = path.posix.dirname(current);
    if (
      parent === current ||
      (parent !== SANDBOX_WORKSPACE_ROOT &&
        !parent.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`))
    ) {
      return undefined;
    }
    current = parent;
  }
}

/** Return Git worktrees under repos/, sorted for stable instruction capture. */
export async function listRepositoryDirectories(
  fs: SandboxFileSystem,
): Promise<string[]> {
  if (!(await directoryExists(fs, SANDBOX_REPOS_ROOT))) {
    return [];
  }

  const entries = await fs.readdir(SANDBOX_REPOS_ROOT);
  const repositories: string[] = [];
  for (const entry of entries) {
    const candidate = path.posix.join(SANDBOX_REPOS_ROOT, entry);
    if (
      (await directoryExists(fs, candidate)) &&
      (await pathExists(fs, path.posix.join(candidate, ".git")))
    ) {
      repositories.push(candidate);
    }
  }
  return repositories.sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** Return the only Git worktree under repos/, without guessing when ambiguous. */
export async function findSingleRepositoryDirectory(
  fs: SandboxFileSystem,
): Promise<string | undefined> {
  const repositories = await listRepositoryDirectories(fs);
  return repositories.length === 1 ? repositories[0] : undefined;
}

async function readInstructionFile(
  fs: SandboxFileSystem,
  filePath: string,
): Promise<string | undefined> {
  try {
    const content = await fs.readFile(filePath, { encoding: "utf8" });
    return content.trim() ? content : undefined;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function readOptionalDirectory(
  fs: SandboxFileSystem,
  directory: string,
): Promise<string[]> {
  try {
    return await fs.readdir(directory);
  } catch (error) {
    if (isMissingPathError(error)) {
      return [];
    }
    throw error;
  }
}

/** Read model-invocable skills from the repository skill directories. */
async function readRepositorySkills(
  fs: SandboxFileSystem,
  gitRoot: string,
): Promise<RepositorySkill[]> {
  const roots = REPOSITORY_SKILL_ROOTS.map((root) =>
    path.posix.join(gitRoot, root),
  );
  const listings = await Promise.all(
    roots.map(async (root) => await readOptionalDirectory(fs, root)),
  );
  // The first root wins for each directory name. Repositories often link
  // `.claude/skills` to `.agents/skills`, so this also skips duplicate reads.
  const candidates = new Map<string, string>();
  listings.forEach((entries, index) => {
    for (const entry of [...entries].sort()) {
      if (!candidates.has(entry)) {
        candidates.set(entry, path.posix.join(roots[index]!, entry));
      }
    }
  });

  const skills = await Promise.all(
    [...candidates].map(async ([name, skillDirectory]) => {
      // Skill roots can also hold plain files, such as a README.
      if (!(await directoryExists(fs, skillDirectory))) {
        return undefined;
      }
      const filePath = path.posix.join(skillDirectory, "SKILL.md");
      const raw = await readInstructionFile(fs, filePath);
      const parsed = raw ? parseSkillFile(raw, name) : undefined;
      if (!parsed?.ok || parsed.skill.disableModelInvocation) {
        return undefined;
      }
      return {
        description: parsed.skill.description.replace(/\s+/g, " ").trim(),
        name,
        path: filePath,
      };
    }),
  );
  return skills
    .filter((skill): skill is RepositorySkill => Boolean(skill))
    .sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
}

type RepositorySources = RepositoryInstructions["sources"];

function sourceBytes(sources: RepositorySources): number {
  return sources.reduce(
    (total, source) => total + Buffer.byteLength(source.content, "utf8"),
    0,
  );
}

function skillListBytes(skills: RepositorySkill[]): number {
  return skills.reduce(
    (total, skill) => total + repositorySkillBytes(skill),
    0,
  );
}

/** Read root-to-cwd AGENTS.md files within the byte budget. */
async function readAgentsSources(args: {
  cwd: string;
  fs: SandboxFileSystem;
  gitRoot: string;
  maxBytes: number;
}): Promise<RepositorySources> {
  const directories: string[] = [];
  let current = args.cwd;
  for (;;) {
    directories.push(current);
    if (current === args.gitRoot) {
      break;
    }
    current = path.posix.dirname(current);
  }
  directories.reverse();

  const sources: RepositorySources = [];
  let remaining = Math.max(0, args.maxBytes);
  for (const directory of directories) {
    if (remaining <= 0) {
      break;
    }
    const filePath = path.posix.join(directory, AGENTS_FILENAME);
    const content = await readInstructionFile(args.fs, filePath);
    if (!content) {
      continue;
    }
    const bytes = Buffer.from(content, "utf8");
    const bounded =
      bytes.length <= remaining
        ? content
        : bytes.subarray(0, remaining).toString("utf8");
    sources.push({ content: bounded, path: filePath });
    remaining -= Buffer.byteLength(bounded, "utf8");
  }
  return sources;
}

/** Read repository skills that fit the byte budget, keeping each entry whole. */
async function readRepositorySkillsWithinBudget(args: {
  fs: SandboxFileSystem;
  gitRoot: string;
  maxBytes: number;
}): Promise<RepositorySkill[]> {
  const skills: RepositorySkill[] = [];
  let remaining = args.maxBytes;
  if (remaining <= 0) {
    return skills;
  }
  for (const skill of await readRepositorySkills(args.fs, args.gitRoot)) {
    const bytes = repositorySkillBytes(skill);
    if (bytes > remaining) {
      break;
    }
    skills.push(skill);
    remaining -= bytes;
  }
  return skills;
}

function buildRepositoryInstructions(
  directory: string,
  sources: RepositorySources,
  skills: RepositorySkill[],
): RepositoryInstructions | undefined {
  if (sources.length === 0 && skills.length === 0) {
    return undefined;
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        directory,
        sources,
        ...(skills.length > 0 ? { skills } : undefined),
      }),
    )
    .digest("hex");
  return {
    directory,
    fingerprint,
    ...(skills.length > 0 ? { skills } : undefined),
    sources,
    text: formatRepositoryInstructions(sources, skills),
  };
}

/** Resolve the root-to-cwd AGENTS.md bundle and repository skills for one selected directory. */
export async function resolveRepositoryInstructions(args: {
  cwd: string;
  fs: SandboxFileSystem;
  maxBytes?: number;
}): Promise<RepositoryInstructions | undefined> {
  const gitRoot = await findGitRoot(args.fs, args.cwd);
  if (!gitRoot) {
    return undefined;
  }
  const maxBytes = args.maxBytes ?? MAX_REPOSITORY_INSTRUCTIONS_BYTES;
  const sources = await readAgentsSources({
    cwd: args.cwd,
    fs: args.fs,
    gitRoot,
    maxBytes,
  });
  // AGENTS.md has priority. Skills use only the budget that remains.
  const skills = await readRepositorySkillsWithinBudget({
    fs: args.fs,
    gitRoot,
    maxBytes: maxBytes - sourceBytes(sources),
  });
  return buildRepositoryInstructions(args.cwd, sources, skills);
}

function formatInstructionSources(
  sources: Array<{ content: string; path: string }>,
): string {
  if (sources.length === 1) {
    return sources[0]!.content;
  }
  return sources
    .map(
      (source) => `## ${path.posix.dirname(source.path)}\n\n${source.content}`,
    )
    .join("\n\n");
}

function formatRepositorySkill(skill: RepositorySkill): string {
  return `- \`${skill.name}\` (\`${skill.path}\`): ${skill.description}`;
}

function repositorySkillBytes(skill: RepositorySkill): number {
  // One extra byte for the line break between entries.
  return Buffer.byteLength(formatRepositorySkill(skill), "utf8") + 1;
}

function formatRepositoryInstructions(
  sources: Array<{ content: string; path: string }>,
  skills: RepositorySkill[],
): string {
  const sections: string[] = [];
  if (sources.length > 0) {
    sections.push(formatInstructionSources(sources));
  }
  if (skills.length > 0) {
    sections.push(
      [REPOSITORY_SKILLS_HEADER, "", ...skills.map(formatRepositorySkill)].join(
        "\n",
      ),
    );
  }
  return sections.join("\n\n");
}

/** Combine AGENTS.md bundles from one or more repository directories. */
export function mergeRepositoryInstructions(
  bundles: RepositoryInstructions[],
): RepositoryInstructions | undefined {
  if (bundles.length === 0) {
    return undefined;
  }
  if (bundles.length === 1) {
    return bundles[0];
  }

  const sources = bundles.flatMap((bundle) => bundle.sources);
  const skills = bundles.flatMap((bundle) => bundle.skills ?? []);
  const text = formatRepositoryInstructions(sources, skills);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        directories: bundles.map((bundle) => bundle.directory ?? null),
        sources,
        ...(skills.length > 0 ? { skills } : undefined),
      }),
    )
    .digest("hex");
  return {
    fingerprint,
    ...(skills.length > 0 ? { skills } : undefined),
    sources,
    text,
  };
}

/** Resolve AGENTS.md instructions for each selected repository directory. */
export async function resolveRepositoryInstructionsForDirectories(args: {
  directories: string[];
  fs: SandboxFileSystem;
}): Promise<RepositoryInstructions | undefined> {
  const uniqueDirectories = [
    ...new Set(
      args.directories.filter(
        (directory) =>
          directory === SANDBOX_WORKSPACE_ROOT ||
          directory.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`),
      ),
    ),
  ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  // One shared budget across every selected repository. Without this, N repos
  // could each contribute the full single-repo limit. Every AGENTS.md comes
  // before any repository skill list. Directory labels and the skills header
  // are tiny and not charged.
  let remaining = MAX_REPOSITORY_INSTRUCTIONS_BYTES;
  const repositories: Array<{
    directory: string;
    gitRoot: string;
    sources: RepositorySources;
  }> = [];
  for (const directory of uniqueDirectories) {
    const gitRoot = await findGitRoot(args.fs, directory);
    if (!gitRoot) {
      continue;
    }
    const sources = await readAgentsSources({
      cwd: directory,
      fs: args.fs,
      gitRoot,
      maxBytes: remaining,
    });
    remaining -= sourceBytes(sources);
    repositories.push({ directory, gitRoot, sources });
  }

  const bundles: RepositoryInstructions[] = [];
  for (const repository of repositories) {
    const skills = await readRepositorySkillsWithinBudget({
      fs: args.fs,
      gitRoot: repository.gitRoot,
      maxBytes: remaining,
    });
    remaining -= skillListBytes(skills);
    const bundle = buildRepositoryInstructions(
      repository.directory,
      repository.sources,
      skills,
    );
    if (bundle) {
      bundles.push(bundle);
    }
  }
  return mergeRepositoryInstructions(bundles);
}

/** Render repository instructions with Codex's exact model-visible wrapper. */
export function renderAgentsInstructions(args: {
  directory?: string;
  text: string;
}): string {
  const directory = args.directory ? ` for ${args.directory}` : "";
  return `# AGENTS.md instructions${directory}\n\n<INSTRUCTIONS>\n${args.text}\n</INSTRUCTIONS>`;
}

/** Build one user-role repository-instructions context message. */
export function buildAgentsInstructionsMessage(args: {
  directory?: string;
  text: string;
  timestamp?: number;
}): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text: renderAgentsInstructions(args) }],
    timestamp: args.timestamp ?? Date.now(),
  } as PiMessage;
}

/** Read the latest effective AGENTS.md state from model-visible history. */
export function findVisibleAgentsInstructions(
  messages: PiMessage[],
): VisibleAgentsInstructions | undefined {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages[messageIndex] as {
      content?: unknown;
      role?: unknown;
    };
    if (message.role !== "user" || !Array.isArray(message.content)) {
      continue;
    }
    for (
      let partIndex = message.content.length - 1;
      partIndex >= 0;
      partIndex -= 1
    ) {
      const part = message.content[partIndex] as {
        text?: unknown;
        type?: unknown;
      };
      if (
        part.type !== "text" ||
        typeof part.text !== "string" ||
        !part.text.startsWith("# AGENTS.md instructions")
      ) {
        continue;
      }
      const match = part.text.match(
        /^# AGENTS\.md instructions(?: for ([^\n]+))?\n\n<INSTRUCTIONS>\n([\s\S]*)\n<\/INSTRUCTIONS>$/,
      );
      if (!match) {
        continue;
      }
      let text = match[2]!;
      if (text === AGENTS_REMOVAL_NOTICE) {
        return { active: false };
      }
      if (text.startsWith(`${AGENTS_REPLACEMENT_NOTICE}\n\n`)) {
        text = text.slice(AGENTS_REPLACEMENT_NOTICE.length + 2);
      }
      return {
        active: true,
        ...(match[1] ? { directory: match[1] } : undefined),
        text,
      };
    }
  }
  return undefined;
}

/** Whether one message is a generated AGENTS.md context update. */
export function isAgentsInstructionsMessage(message: PiMessage): boolean {
  return Boolean(findVisibleAgentsInstructions([message]));
}
