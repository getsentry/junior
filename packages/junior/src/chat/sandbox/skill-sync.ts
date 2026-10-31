import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  SANDBOX_DATA_ROOT,
  SANDBOX_SKILLS_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  sandboxSkillDir,
} from "@/chat/sandbox/paths";
import {
  isAlreadyExistsError,
  throwSandboxOperationError,
} from "@/chat/sandbox/errors";
import type { SetSpanAttributes } from "@/chat/logging";
import type { SandboxSession } from "@/chat/sandbox/workspace";
import type { SkillMetadata } from "@/chat/skills";

interface SkillSyncFile {
  path: string;
  content: Buffer;
}

const DIRECTORY_CREATE_CONCURRENCY = 8;

/**
 * Digest of the last complete skill sync. It lives under the skills root, so
 * removing that directory also forces a full sync.
 */
const SKILL_SYNC_DIGEST_PATH = `${SANDBOX_SKILLS_ROOT}/.sync-digest`;

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
  referenceFiles?: string[],
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

  if (referenceFiles && referenceFiles.length > 0) {
    for (const absoluteFile of referenceFiles) {
      const fileName = path.basename(absoluteFile);
      filesToWrite.push({
        path: `${SANDBOX_DATA_ROOT}/${fileName}`,
        content: await fs.readFile(absoluteFile),
      });
    }
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

function groupDirectoriesByDepth(directories: string[]): string[][] {
  const groups = new Map<number, string[]>();
  for (const directory of directories) {
    const depth = directory.split("/").filter(Boolean).length;
    const group = groups.get(depth) ?? [];
    group.push(directory);
    groups.set(depth, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, group]) => group);
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

/** Resolve a virtual sandbox data path back to the host filesystem when no sandbox exists yet. */
export function resolveHostDataPath(
  referenceFiles: string[],
  sandboxPath: string,
): string | null {
  const normalizedPath = path.posix.normalize(sandboxPath.trim());
  if (
    normalizedPath !== SANDBOX_DATA_ROOT &&
    !normalizedPath.startsWith(`${SANDBOX_DATA_ROOT}/`)
  ) {
    return null;
  }

  const relativePath = path.posix.relative(SANDBOX_DATA_ROOT, normalizedPath);
  if (
    !relativePath ||
    relativePath.startsWith("../") ||
    relativePath.includes("/")
  ) {
    return null;
  }

  for (const hostFile of referenceFiles) {
    if (path.basename(hostFile) === relativePath) {
      return hostFile;
    }
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

function skillSyncDigest(files: SkillSyncFile[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.content.length));
    hash.update("\0");
    hash.update(file.content);
  }
  return hash.digest("hex");
}

async function readSkillSyncDigest(
  sandbox: Pick<SandboxSession, "readFileToBuffer">,
): Promise<string | undefined> {
  const content = await sandbox.readFileToBuffer({
    path: SKILL_SYNC_DIGEST_PATH,
  });
  return content ? content.toString("utf8").trim() : undefined;
}

/**
 * Copy the current skill set and reference files into a sandbox.
 *
 * A reused sandbox skips the copy when its digest matches the files to write.
 */
export async function syncSkillsToSandbox(params: {
  sandbox: Pick<SandboxSession, "mkDir" | "readFileToBuffer" | "writeFiles">;
  skills: SkillMetadata[];
  referenceFiles?: string[];
  withSpan: <T>(
    name: string,
    op: string,
    attributes: Record<string, unknown>,
    callback: (setSpanAttributes: SetSpanAttributes) => Promise<T>,
  ) => Promise<T>;
  workspaceRoot?: string;
}): Promise<void> {
  const workspaceRoot = params.workspaceRoot ?? SANDBOX_WORKSPACE_ROOT;

  await params.withSpan(
    "sandbox.sync_skills",
    "sandbox.sync",
    {
      "app.sandbox.skills_count": params.skills.length,
    },
    async (setSpanAttributes) => {
      const filesToWrite = await buildSkillSyncFiles(
        params.skills,
        params.referenceFiles,
      );
      const digest = skillSyncDigest(filesToWrite);
      if ((await readSkillSyncDigest(params.sandbox)) === digest) {
        setSpanAttributes({ "app.sandbox.sync.skipped": true });
        return;
      }
      setSpanAttributes({ "app.sandbox.sync.skipped": false });
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
            // Finish each parent depth before creating child directories.
            for (const directoriesAtDepth of groupDirectoriesByDepth(
              directories,
            )) {
              for (
                let offset = 0;
                offset < directoriesAtDepth.length;
                offset += DIRECTORY_CREATE_CONCURRENCY
              ) {
                await Promise.all(
                  directoriesAtDepth
                    .slice(offset, offset + DIRECTORY_CREATE_CONCURRENCY)
                    .map(async (directory) => {
                      try {
                        await params.sandbox.mkDir(directory);
                      } catch (error) {
                        if (!isAlreadyExistsError(error)) {
                          throw error;
                        }
                      }
                    }),
                );
              }
            }

            // The digest goes last, so a copy that stops early leaves the
            // old digest and the next sync copies everything again.
            await params.sandbox.writeFiles([
              ...filesToWrite,
              {
                path: SKILL_SYNC_DIGEST_PATH,
                content: Buffer.from(digest, "utf8"),
              },
            ]);
          } catch (error) {
            throwSandboxOperationError("sandbox writeFiles", error, true);
          }
        },
      );
    },
  );
}
