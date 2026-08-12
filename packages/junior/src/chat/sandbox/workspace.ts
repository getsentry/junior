import {
  FileSystem,
  type NetworkPolicy,
  type Sandbox as VercelSandbox,
} from "@vercel/sandbox";
import { isSandboxUnavailableError } from "@/chat/sandbox/errors";

export interface SandboxCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface SandboxCommandInput {
  args?: string[];
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  sudo?: boolean;
  timeoutMs?: number;
}

export interface SandboxFileStat {
  isDirectory(): boolean;
}

export interface SandboxFileSystem {
  readFile(
    filePath: string,
    options: { encoding: BufferEncoding; signal?: AbortSignal },
  ): Promise<string>;
  writeFile(
    filePath: string,
    content: string,
    options?: { encoding?: BufferEncoding; signal?: AbortSignal },
  ): Promise<void>;
  readdir(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<string[]>;
  stat(
    filePath: string,
    options?: { signal?: AbortSignal },
  ): Promise<SandboxFileStat>;
}

/** Bind one tool call's cancellation to every sandbox filesystem operation. */
export function bindSandboxFileSystem(
  fs: SandboxFileSystem,
  signal?: AbortSignal,
): SandboxFileSystem {
  if (!signal) {
    return fs;
  }

  return {
    readFile(filePath, options) {
      signal.throwIfAborted();
      return fs.readFile(filePath, { ...options, signal });
    },
    writeFile(filePath, content, options) {
      signal.throwIfAborted();
      return fs.writeFile(filePath, content, { ...options, signal });
    },
    readdir(filePath) {
      signal.throwIfAborted();
      return fs.readdir(filePath, { signal });
    },
    stat(filePath) {
      signal.throwIfAborted();
      return fs.stat(filePath, { signal });
    },
  };
}

export interface SandboxWorkspace {
  readFileToBuffer(input: {
    cwd?: string;
    path: string;
  }): Promise<Buffer | null | undefined>;
  runCommand(input: SandboxCommandInput): Promise<SandboxCommandResult>;
  writeFiles(
    files: Array<{
      content: string | Uint8Array;
      mode?: number;
      path: string;
    }>,
  ): Promise<void>;
}

export interface SandboxSession extends SandboxWorkspace {
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly fs: SandboxFileSystem;
  extendTimeout(duration: number): Promise<void>;
  mkDir(path: string): Promise<void>;
  snapshot(options?: { signal?: AbortSignal }): Promise<{ snapshotId: string }>;
  stop(): Promise<unknown>;
  update(params: { networkPolicy?: NetworkPolicy }): Promise<void>;
}

/** Pin Junior's sandbox contract to one Vercel session without SDK replay. */
export function createSandboxSession(
  sandbox: VercelSandbox,
  options?: {
    onUnavailable?: (sessionId: string) => void;
  },
): SandboxSession {
  // Pin operations to the acquired VM session. The Sandbox convenience methods
  // may resume and replay an operation after a lifecycle failure.
  const session = sandbox.currentSession();
  const fileSystem = new FileSystem(session);
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (isSandboxUnavailableError(error)) {
        options?.onUnavailable?.(session.sessionId);
      }
      throw error;
    }
  };
  const fs: SandboxFileSystem = {
    readFile: async (filePath, readOptions) =>
      await run(async () => await fileSystem.readFile(filePath, readOptions)),
    writeFile: async (filePath, content, writeOptions) =>
      await run(
        async () => await fileSystem.writeFile(filePath, content, writeOptions),
      ),
    readdir: async (filePath, readOptions) =>
      await run(async () => await fileSystem.readdir(filePath, readOptions)),
    stat: async (filePath, statOptions) =>
      await run(async () => await fileSystem.stat(filePath, statOptions)),
  };

  return {
    sandboxId: sandbox.name,
    sessionId: session.sessionId,
    fs,
    extendTimeout(duration) {
      return run(async () => await session.extendTimeout(duration));
    },
    mkDir(path) {
      return run(async () => await session.mkDir(path));
    },
    readFileToBuffer(input) {
      return run(async () => await session.readFileToBuffer(input));
    },
    async runCommand(input) {
      const result = await run(async () => await session.runCommand(input));
      const [stdout, stderr] = await Promise.all([
        run(async () => await result.stdout()),
        run(async () => await result.stderr()),
      ]);
      return {
        exitCode: result.exitCode,
        stdout,
        stderr,
      };
    },
    snapshot(options) {
      return run(async () => {
        const snapshot = await session.snapshot(options);
        return { snapshotId: snapshot.snapshotId };
      });
    },
    stop() {
      return run(async () => await session.stop());
    },
    update(params) {
      return run(async () => await session.update(params));
    },
    writeFiles(files) {
      return run(async () => await session.writeFiles(files));
    },
  };
}

/** Best-effort stop; ignore secondary stop failures during cleanup. */
export async function stopSession(
  session: { stop: () => Promise<unknown> } | null | undefined,
): Promise<void> {
  if (!session) return;
  try {
    await session.stop();
  } catch {
    // Best-effort stop during cleanup.
  }
}
