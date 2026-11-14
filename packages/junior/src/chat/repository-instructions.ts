import { createHash } from "node:crypto";
import path from "node:path";
import type { PiMessage } from "@/chat/pi/messages";
import {
  SANDBOX_REPOS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import { parseSkillFile } from "@/chat/skills";
import type { SandboxCommandRunner } from "@/chat/tools/sandbox/file-utils";

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

/**
 * Read limit for each AGENTS.md and SKILL.md file. It is 3 bytes past the
 * budget: a UTF-8 character has at most 4 bytes, so a character cut at this
 * limit starts after the budget, and the budgeted text is the same as with a
 * full read.
 */
const FILE_READ_LIMIT_BYTES = MAX_REPOSITORY_INSTRUCTIONS_BYTES + 3;

/**
 * Print every path and file that the instructions read needs, one record per
 * line. The cwd is the workspace root, and all paths are relative to it.
 *
 * Arguments: the file read limit, then `repos` to read every Git worktree in
 * it or "", then one group for each selected directory. A group holds the
 * directories from the selected directory up to the workspace root, then "".
 * A group stops at its first directory with `.git`.
 *
 * Records: `R <dir>` for a Git worktree in repos/, `G <dir>/.git`, `D <path>`
 * for a directory in a skill root, `E <path>` for another entry in a skill
 * root, and `F <base64> <path>` for an AGENTS.md or SKILL.md file. File
 * tests follow symlinks like `stat -L`. Globs skip dot entries like `ls -1`,
 * which the Vercel Sandbox `readdir` runs.
 */
const READ_SCRIPT = `
limit=$1
repos=$2
shift 2

nl='
'
# A glob result is an entry when it exists. Like the lines of \`ls -1\`, a
# name with a line break does not name an entry.
listed() {
  case $1 in *"$nl"*) return 1 ;; esac
  [ -e "$1" ] || [ -L "$1" ]
}

emit_file() {
  [ -f "$1" ] || return 0
  if [ ! -r "$1" ]; then
    printf 'cannot read %s\\n' "$1" >&2
    exit 1
  fi
  printf 'F '
  head -c "$limit" < "$1" | base64 | tr -d '\\n'
  printf ' %s\\n' "$1"
}

emit_skills() {
  for entry in "$1/.agents/skills"/* "$1/.claude/skills"/*; do
    listed "$entry" || continue
    # The first skill root wins for each name. Skip entries that it shadows.
    case $entry in
      "$1/.claude/skills/"*) listed "$1/.agents/skills/\${entry##*/}" && continue ;;
    esac
    if [ -d "$entry" ]; then
      printf 'D %s\\n' "$entry"
      emit_file "$entry/SKILL.md"
    else
      printf 'E %s\\n' "$entry"
    fi
  done
}

if [ -n "$repos" ]; then
  for repo in "$repos"/*; do
    if listed "$repo" && [ -d "$repo" ] && [ -e "$repo/.git" ]; then
      printf 'R %s\\n' "$repo"
      set -- "$@" "$repo" ""
    fi
  done
fi

found=
for dir in "$@"; do
  if [ -z "$dir" ]; then
    found=
  elif [ -z "$found" ]; then
    emit_file "$dir/AGENTS.md"
    if [ -e "$dir/.git" ]; then
      printf 'G %s/.git\\n' "$dir"
      emit_skills "$dir"
      found=1
    fi
  fi
done
`;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Sandbox paths and files that one instructions read found. */
interface RepositoryTree {
  /** Entries of each skill root, by name, with whether each is a directory. */
  entries: Map<string, Map<string, boolean>>;
  /** AGENTS.md and SKILL.md contents, cut at `FILE_READ_LIMIT_BYTES`. */
  files: Map<string, string>;
  /** `.git` paths that exist, as a file or a directory. */
  gitMarkers: Set<string>;
  /** Git worktrees under repos/. */
  repositories: string[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Directories that the Git root search checks, from cwd up to the workspace root. */
function gitRootCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  let current = cwd;
  for (;;) {
    candidates.push(current);
    if (current === SANDBOX_WORKSPACE_ROOT) {
      return candidates;
    }
    const parent = path.posix.dirname(current);
    if (
      parent === current ||
      (parent !== SANDBOX_WORKSPACE_ROOT &&
        !parent.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`))
    ) {
      return candidates;
    }
    current = parent;
  }
}

function findGitRoot(tree: RepositoryTree, cwd: string): string | undefined {
  return gitRootCandidates(cwd).find((directory) =>
    tree.gitMarkers.has(path.posix.join(directory, ".git")),
  );
}

function invalidOutput(): Error {
  return new Error("Repository instructions read printed invalid output");
}

function parseRepositoryTree(stdout: string): RepositoryTree {
  const tree: RepositoryTree = {
    entries: new Map(),
    files: new Map(),
    gitMarkers: new Set(),
    repositories: [],
  };
  const lines = stdout.split("\n");
  if (lines.pop() !== "") {
    throw invalidOutput();
  }
  for (const line of lines) {
    const kind = line.slice(0, 2);
    let target = line.slice(2);
    let content = "";
    if (kind === "F ") {
      const separator = target.indexOf(" ");
      if (separator < 0) {
        throw invalidOutput();
      }
      content = target.slice(0, separator);
      target = target.slice(separator + 1);
      if (!BASE64_PATTERN.test(content)) {
        throw invalidOutput();
      }
    }
    if (!target) {
      throw invalidOutput();
    }
    const absolute = path.posix.join(SANDBOX_WORKSPACE_ROOT, target);
    switch (kind) {
      case "R ":
        tree.repositories.push(absolute);
        break;
      case "G ":
        tree.gitMarkers.add(absolute);
        break;
      case "D ":
      case "E ": {
        const root = path.posix.dirname(absolute);
        const entries = tree.entries.get(root) ?? new Map<string, boolean>();
        entries.set(path.posix.basename(absolute), kind === "D ");
        tree.entries.set(root, entries);
        break;
      }
      case "F ":
        tree.files.set(
          absolute,
          Buffer.from(content, "base64").toString("utf8"),
        );
        break;
      default:
        throw invalidOutput();
    }
  }
  tree.repositories.sort(compareStrings);
  return tree;
}

/** Read what the selected directories need with one sandbox command. */
async function readRepositoryTree(args: {
  directories: string[];
  discover: boolean;
  runCommand: SandboxCommandRunner;
}): Promise<RepositoryTree> {
  const relative = (target: string) =>
    path.posix.relative(SANDBOX_WORKSPACE_ROOT, target) || ".";
  const result = await args.runCommand({
    cmd: "sh",
    args: [
      "-c",
      READ_SCRIPT,
      "sh",
      String(FILE_READ_LIMIT_BYTES),
      args.discover ? relative(SANDBOX_REPOS_ROOT) : "",
      ...args.directories.flatMap((directory) => [
        ...gitRootCandidates(directory).map(relative),
        "",
      ]),
    ],
    cwd: SANDBOX_WORKSPACE_ROOT,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Repository instructions read failed with exit code ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  return parseRepositoryTree(result.stdout);
}

function readInstructionFile(
  tree: RepositoryTree,
  filePath: string,
): string | undefined {
  const content = tree.files.get(filePath);
  return content?.trim() ? content : undefined;
}

/** Read model-invocable skills from the repository skill directories. */
function readRepositorySkills(
  tree: RepositoryTree,
  gitRoot: string,
): RepositorySkill[] {
  // The first root wins for each directory name. Repositories often link
  // `.claude/skills` to `.agents/skills`.
  const candidates = new Map<string, { directory: boolean; path: string }>();
  for (const root of REPOSITORY_SKILL_ROOTS) {
    const rootPath = path.posix.join(gitRoot, root);
    const entries = [...(tree.entries.get(rootPath) ?? [])].sort(
      ([left], [right]) => compareStrings(left, right),
    );
    for (const [name, directory] of entries) {
      if (!candidates.has(name)) {
        candidates.set(name, {
          directory,
          path: path.posix.join(rootPath, name),
        });
      }
    }
  }

  const skills: RepositorySkill[] = [];
  for (const [name, candidate] of candidates) {
    // Skill roots can also hold plain files, such as a README.
    if (!candidate.directory) {
      continue;
    }
    const filePath = path.posix.join(candidate.path, "SKILL.md");
    const raw = readInstructionFile(tree, filePath);
    const parsed = raw ? parseSkillFile(raw, name) : undefined;
    if (!parsed?.ok || parsed.skill.disableModelInvocation) {
      continue;
    }
    skills.push({
      description: parsed.skill.description.replace(/\s+/g, " ").trim(),
      name,
      path: filePath,
    });
  }
  return skills.sort((left, right) => compareStrings(left.name, right.name));
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
function readAgentsSources(args: {
  cwd: string;
  gitRoot: string;
  maxBytes: number;
  tree: RepositoryTree;
}): RepositorySources {
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
    const content = readInstructionFile(args.tree, filePath);
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
function readRepositorySkillsWithinBudget(args: {
  gitRoot: string;
  maxBytes: number;
  tree: RepositoryTree;
}): RepositorySkill[] {
  const skills: RepositorySkill[] = [];
  let remaining = args.maxBytes;
  if (remaining <= 0) {
    return skills;
  }
  for (const skill of readRepositorySkills(args.tree, args.gitRoot)) {
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

/**
 * Read AGENTS.md instructions and repository skills for the selected
 * directories with one sandbox command. Without directories, use every Git
 * worktree under repos/.
 */
export async function readRepositoryInstructions(args: {
  directories?: string[];
  runCommand: SandboxCommandRunner;
}): Promise<{
  /** The selected directories, or the Git worktrees found under repos/. */
  directories: string[];
  instructions: RepositoryInstructions | undefined;
}> {
  const selected = [
    ...new Set(
      (args.directories ?? []).filter(
        (directory) =>
          directory === SANDBOX_WORKSPACE_ROOT ||
          directory.startsWith(`${SANDBOX_WORKSPACE_ROOT}/`),
      ),
    ),
  ].sort(compareStrings);
  if (args.directories && selected.length === 0) {
    return { directories: args.directories, instructions: undefined };
  }
  const tree = await readRepositoryTree({
    directories: selected,
    discover: !args.directories,
    runCommand: args.runCommand,
  });
  // Git worktrees under repos/ are already sorted, unique, and in the
  // workspace root.
  const cwds = args.directories ? selected : tree.repositories;

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
  for (const directory of cwds) {
    const gitRoot = findGitRoot(tree, directory);
    if (!gitRoot) {
      continue;
    }
    const sources = readAgentsSources({
      cwd: directory,
      gitRoot,
      maxBytes: remaining,
      tree,
    });
    remaining -= sourceBytes(sources);
    repositories.push({ directory, gitRoot, sources });
  }

  const bundles: RepositoryInstructions[] = [];
  for (const repository of repositories) {
    const skills = readRepositorySkillsWithinBudget({
      gitRoot: repository.gitRoot,
      maxBytes: remaining,
      tree,
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
  return {
    directories: args.directories ?? cwds,
    instructions: mergeRepositoryInstructions(bundles),
  };
}

/** Render repository instructions with Codex's exact model-visible wrapper. */
export function renderAgentsInstructions(args: {
  directory?: string | undefined;
  text: string;
}): string {
  const directory = args.directory ? ` for ${args.directory}` : "";
  return `# AGENTS.md instructions${directory}\n\n<INSTRUCTIONS>\n${args.text}\n</INSTRUCTIONS>`;
}

/** Build one user-role repository-instructions context message. */
export function buildAgentsInstructionsMessage(args: {
  directory?: string | undefined;
  text: string;
  timestamp?: number;
}): PiMessage {
  return {
    role: "user",
    content: [{ type: "text", text: renderAgentsInstructions(args) }],
    timestamp: args.timestamp ?? Date.now(),
  };
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

/** Whether the visible AGENTS.md state already shows these instructions. */
export function showsAgentsInstructions(
  visible: VisibleAgentsInstructions | undefined,
  instructions: RepositoryInstructions,
): boolean {
  return (
    visible?.active === true &&
    visible.directory === instructions.directory &&
    visible.text === instructions.text
  );
}

/**
 * Render the AGENTS.md block that a new prompt adds. Return nothing when the
 * latest copy in history already shows these instructions, so a Turn does
 * not repeat an unchanged block.
 */
export function renderAgentsInstructionsForPrompt(
  history: PiMessage[],
  instructions: RepositoryInstructions,
): string | undefined {
  const visible = findVisibleAgentsInstructions(history);
  if (showsAgentsInstructions(visible, instructions)) {
    return undefined;
  }
  return renderAgentsInstructions({
    directory: instructions.directory,
    text:
      visible?.active === true
        ? `${AGENTS_REPLACEMENT_NOTICE}\n\n${instructions.text}`
        : instructions.text,
  });
}

/** Whether one message is a generated AGENTS.md context update. */
export function isAgentsInstructionsMessage(message: PiMessage): boolean {
  return Boolean(findVisibleAgentsInstructions([message]));
}
