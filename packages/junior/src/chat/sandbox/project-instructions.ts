import path from "node:path";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxFileSystem } from "@/chat/sandbox/workspace";

const INSTRUCTION_FILE = "AGENTS.md";

export interface ProjectInstruction {
  path: string;
  content: string;
}

async function pathExists(fs: SandboxFileSystem, candidate: string) {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function findProjectRoot(
  fs: SandboxFileSystem,
  targetDirectory: string,
): Promise<string | undefined> {
  let directory = targetDirectory;
  while (directory.startsWith(SANDBOX_WORKSPACE_ROOT)) {
    if (await pathExists(fs, path.posix.join(directory, ".git"))) {
      return directory;
    }
    if (directory === SANDBOX_WORKSPACE_ROOT) {
      break;
    }
    directory = path.posix.dirname(directory);
  }
  return undefined;
}

/** Load applicable AGENTS instructions from the project root through the target directory. */
export async function resolveProjectInstructions(
  fs: SandboxFileSystem,
  targetDirectory: string,
): Promise<ProjectInstruction[]> {
  const normalizedTarget = path.posix.resolve(
    SANDBOX_WORKSPACE_ROOT,
    targetDirectory,
  );
  const projectRoot = await findProjectRoot(fs, normalizedTarget);
  if (!projectRoot) {
    return [];
  }

  const directories: string[] = [];
  let directory = normalizedTarget;
  while (true) {
    directories.push(directory);
    if (directory === projectRoot) {
      break;
    }
    directory = path.posix.dirname(directory);
  }
  directories.reverse();

  const instructions: ProjectInstruction[] = [];
  for (const scopedDirectory of directories) {
    const instructionPath = path.posix.join(scopedDirectory, INSTRUCTION_FILE);
    try {
      const content = await fs.readFile(instructionPath, { encoding: "utf8" });
      instructions.push({ path: instructionPath, content });
    } catch {
      // Missing instruction files are expected.
    }
  }
  return instructions;
}

/** Find repositories checked out directly under the sandbox workspace. */
export async function discoverWorkspaceProjectRoots(
  fs: SandboxFileSystem,
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(SANDBOX_WORKSPACE_ROOT);
  } catch {
    return [];
  }

  const roots = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.posix.join(SANDBOX_WORKSPACE_ROOT, entry);
      return (await pathExists(fs, path.posix.join(candidate, ".git")))
        ? candidate
        : undefined;
    }),
  );
  return roots.filter((root): root is string => root !== undefined);
}
