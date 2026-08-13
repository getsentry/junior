import { createHash } from "node:crypto";
import path from "node:path";
import type { PiMessage } from "@/chat/pi/messages";
import {
  SANDBOX_REPOS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
} from "@/chat/sandbox/paths";
import type { SandboxFileSystem } from "@/chat/sandbox/workspace";
import { isMissingPathError } from "@/chat/tools/sandbox/file-utils";

const AGENTS_FILENAME = "AGENTS.md";
const MAX_REPOSITORY_INSTRUCTIONS_BYTES = 32 * 1024;

export const AGENTS_REPLACEMENT_NOTICE =
  "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.";
export const AGENTS_REMOVAL_NOTICE =
  "The previously provided AGENTS.md instructions no longer apply.";

/** Effective AGENTS.md instructions plus host-only discovery provenance. */
export interface RepositoryInstructions {
  directory: string;
  fingerprint: string;
  sources: Array<{ content: string; path: string }>;
  text: string;
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

/** Return the only Git worktree under repos/, without guessing when ambiguous. */
export async function findSingleRepositoryDirectory(
  fs: SandboxFileSystem,
): Promise<string | undefined> {
  if (!(await directoryExists(fs, SANDBOX_REPOS_ROOT))) {
    return undefined;
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
      if (repositories.length > 1) {
        return undefined;
      }
    }
  }
  return repositories[0];
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

/** Resolve the effective root-to-cwd AGENTS.md bundle for one selected directory. */
export async function resolveRepositoryInstructions(args: {
  cwd: string;
  fs: SandboxFileSystem;
}): Promise<RepositoryInstructions | undefined> {
  const gitRoot = await findGitRoot(args.fs, args.cwd);
  if (!gitRoot) {
    return undefined;
  }

  const directories: string[] = [];
  let current = args.cwd;
  for (;;) {
    directories.push(current);
    if (current === gitRoot) {
      break;
    }
    current = path.posix.dirname(current);
  }
  directories.reverse();

  const sources: RepositoryInstructions["sources"] = [];
  let remaining = MAX_REPOSITORY_INSTRUCTIONS_BYTES;
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
  if (sources.length === 0) {
    return undefined;
  }

  const text = sources.map((source) => source.content).join("\n\n");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ directory: args.cwd, sources }))
    .digest("hex");
  return { directory: args.cwd, fingerprint, sources, text };
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
        ...(match[1] ? { directory: match[1] } : {}),
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
