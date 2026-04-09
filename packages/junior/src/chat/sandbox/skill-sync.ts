import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { buildEvalGitHubCliStub } from "@/chat/sandbox/eval-gh-stub";
import { runNonInteractiveCommand } from "@/chat/sandbox/noninteractive-command";
import {
  SANDBOX_SKILLS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  sandboxSkillDir,
} from "@/chat/sandbox/paths";
import {
  isAlreadyExistsError,
  throwSandboxOperationError,
} from "@/chat/sandbox/errors";
import type { SkillMetadata } from "@/chat/skills";

interface SkillSyncFile {
  path: string;
  content: Buffer;
}

function toPosixRelative(base: string, absolute: string): string {
  return path.relative(base, absolute).split(path.sep).join("/");
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const queue: string[] = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  return files;
}

async function buildSkillSyncFiles(
  availableSkills: SkillMetadata[],
  runtimeBinDir: string,
): Promise<SkillSyncFile[]> {
  const filesToWrite: SkillSyncFile[] = [];
  const index = {
    skills: [] as Array<{
      name: string;
      description: string;
      root: string;
    }>,
  };

  for (const skill of availableSkills) {
    const skillFiles = await listFilesRecursive(skill.skillPath);
    for (const absoluteFile of skillFiles) {
      const relative = toPosixRelative(skill.skillPath, absoluteFile);
      if (!relative || relative.startsWith("..")) {
        continue;
      }
      filesToWrite.push({
        path: `${sandboxSkillDir(skill.name)}/${relative}`,
        content: await fs.readFile(absoluteFile),
      });
    }

    index.skills.push({
      name: skill.name,
      description: skill.description,
      root: sandboxSkillDir(skill.name),
    });
  }

  filesToWrite.push({
    path: `${SANDBOX_SKILLS_ROOT}/index.json`,
    content: Buffer.from(JSON.stringify(index), "utf8"),
  });

  if (process.env.EVAL_ENABLE_TEST_CREDENTIALS === "1") {
    filesToWrite.push({
      path: `${runtimeBinDir}/gh`,
      content: Buffer.from(buildEvalGitHubCliStub(), "utf8"),
    });
  }

  return filesToWrite;
}

function collectDirectories(
  filesToWrite: SkillSyncFile[],
  workspaceRoot: string,
): string[] {
  const directoriesToEnsure = new Set<string>();
  for (const file of filesToWrite) {
    const normalizedPath = path.posix.normalize(file.path);
    const parts = normalizedPath.split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < parts.length - 1; index += 1) {
      current = `${current}/${parts[index]}`;
      directoriesToEnsure.add(current);
    }
  }

  return Array.from(directoriesToEnsure)
    .filter(
      (directory) =>
        directory === workspaceRoot ||
        directory.startsWith(`${workspaceRoot}/`),
    )
    .sort((a, b) => a.length - b.length);
}

/** Resolve a virtual sandbox skill path back to the host filesystem when no sandbox exists yet. */
export function resolveHostSkillPath(
  availableSkills: SkillMetadata[],
  sandboxPath: string,
): string | null {
  const normalizedPath = path.posix.normalize(sandboxPath.trim());

  for (const skill of availableSkills) {
    const virtualRoot = sandboxSkillDir(skill.name);
    if (
      normalizedPath !== virtualRoot &&
      !normalizedPath.startsWith(`${virtualRoot}/`)
    ) {
      continue;
    }

    const relativePath = path.posix.relative(virtualRoot, normalizedPath);
    if (!relativePath || relativePath.startsWith("../")) {
      return null;
    }

    const hostRoot = path.resolve(skill.skillPath);
    const hostPath = path.resolve(hostRoot, ...relativePath.split("/"));
    if (
      hostPath !== hostRoot &&
      !hostPath.startsWith(`${hostRoot}${path.sep}`)
    ) {
      return null;
    }

    return hostPath;
  }

  return null;
}

/** Detect missing host-backed skill files so reads can fall back to the sandbox copy. */
export function isHostFileMissingError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { code?: unknown }).code === "ENOENT",
  );
}

/** Copy the current skill set into a sandbox and mark runtime shims executable. */
export async function syncSkillsToSandbox(params: {
  sandbox: Sandbox;
  skills: SkillMetadata[];
  withSpan: <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: () => Promise<T>,
  ) => Promise<T>;
  runtimeBinDir: string;
  workspaceRoot?: string;
}): Promise<void> {
  const workspaceRoot = params.workspaceRoot ?? SANDBOX_WORKSPACE_ROOT;

  await params.withSpan(
    "sandbox.sync_skills",
    "sandbox.sync",
    {
      "app.sandbox.skills_count": params.skills.length,
    },
    async () => {
      const filesToWrite = await buildSkillSyncFiles(
        params.skills,
        params.runtimeBinDir,
      );
      const bytesWritten = filesToWrite.reduce(
        (total, file) => total + file.content.length,
        0,
      );
      const directories = collectDirectories(filesToWrite, workspaceRoot);

      await params.withSpan(
        "sandbox.sync_writeFiles",
        "sandbox.sync.write",
        {
          "app.sandbox.sync.files_written": filesToWrite.length,
          "app.sandbox.sync.bytes_written": bytesWritten,
          "app.sandbox.sync.directories_ensured": directories.length,
        },
        async () => {
          try {
            for (const directory of directories) {
              try {
                await params.sandbox.mkDir(directory);
              } catch (error) {
                if (!isAlreadyExistsError(error)) {
                  throw error;
                }
              }
            }

            await params.sandbox.writeFiles(filesToWrite);
            const executableFiles = filesToWrite
              .map((file) => file.path)
              .filter((filePath) =>
                filePath.startsWith(`${params.runtimeBinDir}/`),
              );
            for (const filePath of executableFiles) {
              const chmod = await runNonInteractiveCommand(params.sandbox, {
                cmd: "chmod",
                args: ["0755", filePath],
                cwd: workspaceRoot,
              });
              if (chmod.exitCode !== 0) {
                throw new Error(
                  `sandbox chmod failed for ${filePath}: ${(await chmod.stderr()) || (await chmod.stdout()) || `exit ${chmod.exitCode}`}`,
                );
              }
            }
          } catch (error) {
            throwSandboxOperationError("sandbox writeFiles", error, true);
          }
        },
      );
    },
  );
}
