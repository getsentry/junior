import path from "node:path";
import {
  DockerApiError,
  dockerJson,
  dockerRequest,
  dockerStream,
} from "@/chat/sandbox/docker/api";
import {
  extendDeadline,
  SANDBOX_FILE_OWNER,
  stopContainer,
  type SandboxContainer,
} from "@/chat/sandbox/docker/container";
import { applyEgressPolicy } from "@/chat/sandbox/docker/egress";
import { dockerSandboxErrors } from "@/chat/sandbox/docker/errors";
import { runRawExec, runSandboxCommand } from "@/chat/sandbox/docker/exec";
import { DOCKER_SANDBOX_LABEL } from "@/chat/sandbox/docker/settings";
import { packTar, unpackFirstFile } from "@/chat/sandbox/docker/tar";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import type {
  SandboxFileSystem,
  SandboxSession,
  SandboxSessionOptions,
} from "@/chat/sandbox/workspace";

// Module overview: Junior's `SandboxSession` contract on top of one running
// sandbox container. Commands use Docker exec. Files use Docker's archive API.

/** Image repository for every snapshot that this provider captures. */
export const SNAPSHOT_REPOSITORY = "junior-sandbox-snapshot";
/** Go's `os.ModeDir` bit in Docker's path stat header. */
const MODE_DIR = 2 ** 31;

function absolute(filePath: string, cwd?: string): string {
  return path.posix.resolve(cwd ?? SANDBOX_WORKSPACE_ROOT, filePath);
}

function notFound(filePath: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, '${filePath}'`),
    { code: "ENOENT" },
  );
}

async function readFile(
  id: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const archive = await dockerRequest({
      path: `/containers/${id}/archive`,
      query: { path: filePath },
      signal,
    });
    return unpackFirstFile(archive);
  } catch (error) {
    if (error instanceof DockerApiError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function writeFiles(
  id: string,
  files: Array<{ content: string | Uint8Array; mode?: number; path: string }>,
  signal?: AbortSignal,
): Promise<void> {
  const entries = files.map((file) => ({
    path: absolute(file.path),
    content:
      typeof file.content === "string"
        ? Buffer.from(file.content)
        : file.content,
    mode: file.mode ?? 0o644,
  }));
  // Create parent directories as the sandbox user, like a Vercel Sandbox
  // write. Docker would create missing parents as root.
  const parents = [
    ...new Set(entries.map((entry) => path.posix.dirname(entry.path))),
  ];
  await runRawExec(id, { cmd: ["mkdir", "-p", ...parents] }, signal);
  await dockerRequest({
    method: "PUT",
    path: `/containers/${id}/archive`,
    query: { path: "/" },
    body: packTar(
      entries.map((entry) => ({
        ...entry,
        path: entry.path.replace(/^\/+/, ""),
        uid: SANDBOX_FILE_OWNER.uid,
        gid: SANDBOX_FILE_OWNER.gid,
      })),
    ),
    signal,
  });
}

async function statMode(
  id: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<number | null> {
  const response = await dockerStream({
    method: "HEAD",
    path: `/containers/${id}/archive`,
    query: { path: filePath },
    signal,
  });
  response.resume();
  if (response.statusCode === 404) return null;
  const header = response.headers["x-docker-container-path-stat"];
  if ((response.statusCode ?? 0) >= 400 || typeof header !== "string") {
    throw new DockerApiError(
      response.statusCode ?? 0,
      `stat ${filePath} failed`,
    );
  }
  const stat = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    mode: number;
  };
  return stat.mode;
}

function fileSystem(id: string): SandboxFileSystem {
  return {
    async readFile(filePath, options) {
      const target = absolute(filePath);
      const content = await readFile(id, target, options.signal);
      if (!content) throw notFound(target);
      return content.toString(options.encoding);
    },
    async writeFile(filePath, content, options) {
      await writeFiles(
        id,
        [
          {
            path: filePath,
            content: Buffer.from(content, options?.encoding ?? "utf8"),
          },
        ],
        options?.signal,
      );
    },
    async readdir(filePath, options) {
      const target = absolute(filePath);
      const result = await runRawExec(
        id,
        {
          cmd: [
            "find",
            target,
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "-printf",
            "%f\\0",
          ],
        },
        options?.signal,
      );
      if (result.exitCode !== 0) throw notFound(target);
      return result.stdout.split("\0").filter(Boolean);
    },
    async stat(filePath, options) {
      const target = absolute(filePath);
      const mode = await statMode(id, target, options?.signal);
      if (mode === null) throw notFound(target);
      return { isDirectory: () => mode >= MODE_DIR };
    },
  };
}

/** Commit the container to a local image and return the image id. */
export async function commitSnapshot(
  id: string,
  tag: string,
  signal?: AbortSignal,
): Promise<string> {
  const committed = await dockerJson<{ Id: string }>({
    method: "POST",
    path: "/commit",
    query: {
      container: id,
      repo: SNAPSHOT_REPOSITORY,
      tag,
      changes: `LABEL ${DOCKER_SANDBOX_LABEL}=snapshot`,
    },
    signal,
  });
  return committed.Id;
}

/** Junior's sandbox session contract for one running sandbox container. */
export function adaptSession(
  container: SandboxContainer,
  options?: SandboxSessionOptions,
): SandboxSession {
  const { id } = container;
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    options?.scopeSignal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (dockerSandboxErrors.isUnavailable(error)) {
        options?.onUnavailable?.(id);
      }
      throw error;
    }
  };
  const fs = fileSystem(id);
  const wrapped: SandboxFileSystem = {
    readFile: (filePath, readOptions) =>
      run(() => fs.readFile(filePath, readOptions)),
    writeFile: (filePath, content, writeOptions) =>
      run(() => fs.writeFile(filePath, content, writeOptions)),
    readdir: (filePath, readOptions) =>
      run(() => fs.readdir(filePath, readOptions)),
    stat: (filePath, statOptions) => run(() => fs.stat(filePath, statOptions)),
  };

  return {
    sandboxId: container.name,
    sessionId: id,
    fs: wrapped,
    extendTimeout: (duration) => run(() => extendDeadline(id, duration)),
    mkDir: (dirPath) =>
      run(async () => {
        const target = absolute(dirPath);
        const result = await runRawExec(id, { cmd: ["mkdir", target] });
        if (result.exitCode !== 0) {
          throw new Error(`mkdir ${target} failed: ${result.stderr.trim()}`);
        }
      }),
    readFileToBuffer: (input) =>
      run(() => readFile(id, absolute(input.path, input.cwd))),
    runCommand: (input) =>
      run(() =>
        runSandboxCommand(id, {
          ...input,
          cwd: input.cwd ?? SANDBOX_WORKSPACE_ROOT,
          signal: input.signal ?? options?.scopeSignal,
        }),
      ),
    snapshot: (snapshotOptions) =>
      run(async () => ({
        snapshotId: await commitSnapshot(
          id,
          container.name,
          snapshotOptions?.signal,
        ),
      })),
    stop: () => run(() => stopContainer(id)),
    update: (params) =>
      run(async () => {
        if (params.networkPolicy) {
          await applyEgressPolicy(container, params.networkPolicy);
        }
      }),
    writeFiles: (files) => run(() => writeFiles(id, files)),
  };
}
