import path from "node:path";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type { SandboxFileSystem } from "@/chat/sandbox/workspace";

const PROJECT_CWD_REGISTRY = `${SANDBOX_WORKSPACE_ROOT}/.junior/project-cwds`;
const INSTRUCTION_FILES = ["AGENTS.override.md", "AGENTS.md"] as const;

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
    for (const filename of INSTRUCTION_FILES) {
      const instructionPath = path.posix.join(scopedDirectory, filename);
      try {
        const content = await fs.readFile(instructionPath, { encoding: "utf8" });
        instructions.push({ path: instructionPath, content });
        break;
      } catch {
        // Missing instruction files are expected.
      }
    }
  }
  return instructions;
}

/** Consume repository paths recorded by Git post-checkout hooks. */
export async function consumeRegisteredProjectCwds(
  fs: SandboxFileSystem,
): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(PROJECT_CWD_REGISTRY, { encoding: "utf8" });
  } catch {
    return [];
  }
  await fs.writeFile(PROJECT_CWD_REGISTRY, "", { encoding: "utf8" });
  return [...new Set(content.split("\n").map((line) => line.trim()).filter(Boolean))];
}
