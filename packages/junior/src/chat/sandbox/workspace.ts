/** One outbound rule for a domain in a Sandbox network policy. */
export type SandboxNetworkRule =
  | { forwardURL: string }
  | { transform: Array<{ headers: Record<string, string> }> };

/**
 * Outbound network access for one Sandbox.
 *
 * `allow-all` opens the network. The object form lists domains and their
 * rules; `*` with no rules allows every other domain.
 */
export type SandboxNetworkPolicy =
  | "allow-all"
  | { allow: Record<string, SandboxNetworkRule[]> };

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
  update(params: { networkPolicy?: SandboxNetworkPolicy }): Promise<void>;
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
