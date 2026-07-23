import {
  FileSystem,
  type NetworkPolicy,
  type Sandbox as VercelSandbox,
} from "@vercel/sandbox";

export interface SandboxCommandResult {
  exitCode: number;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
}

export interface SandboxCommandInput {
  args?: string[];
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  sudo?: boolean;
}

export interface SandboxFileStat {
  isDirectory(): boolean;
}

export interface SandboxFileSystem {
  readFile(
    filePath: string,
    options: { encoding: BufferEncoding },
  ): Promise<string>;
  writeFile(
    filePath: string,
    content: string,
    options?: { encoding?: BufferEncoding },
  ): Promise<void>;
  readdir(filePath: string): Promise<string[]>;
  stat(filePath: string): Promise<SandboxFileStat>;
}

export interface SandboxWorkspace {
  readFileToBuffer(input: {
    cwd?: string;
    path: string;
  }): Promise<Buffer | null | undefined>;
  runCommand(input: SandboxCommandInput): Promise<SandboxCommandResult>;
}

export interface SandboxInstance extends SandboxWorkspace {
  readonly sandboxId: string;
  readonly sandboxEgressId: string;
  readonly fs: SandboxFileSystem;
  extendTimeout(duration: number): Promise<void>;
  mkDir(path: string): Promise<void>;
  snapshot(): Promise<{ snapshotId: string }>;
  stop(): Promise<unknown>;
  update(params: { networkPolicy?: NetworkPolicy }): Promise<void>;
  writeFiles(
    files: Array<{
      content: string | Uint8Array;
      mode?: number;
      path: string;
    }>,
  ): Promise<void>;
}

/** Adapt the Vercel SDK object once so the rest of Junior sees one sandbox contract. */
export function createSandboxInstance(sandbox: VercelSandbox): SandboxInstance {
  // Pin operations to the acquired VM session. The Sandbox convenience methods
  // may resume and replay an operation after a lifecycle failure.
  const session = sandbox.currentSession();

  return {
    sandboxId: sandbox.name,
    sandboxEgressId: session.sessionId,
    fs: new FileSystem(session) as SandboxFileSystem,
    extendTimeout(duration) {
      return session.extendTimeout(duration);
    },
    mkDir(path) {
      return session.mkDir(path);
    },
    readFileToBuffer(input) {
      return session.readFileToBuffer(input);
    },
    runCommand(input) {
      return session.runCommand(input);
    },
    async snapshot() {
      const snapshot = await session.snapshot();
      return { snapshotId: snapshot.snapshotId };
    },
    stop() {
      return session.stop();
    },
    update(params) {
      return session.update(params);
    },
    writeFiles(files) {
      return session.writeFiles(files);
    },
  };
}
