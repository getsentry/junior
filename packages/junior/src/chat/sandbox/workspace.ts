import type { NetworkPolicy, Sandbox as VercelSandbox } from "@vercel/sandbox";

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
  return {
    sandboxId: sandbox.name,
    get sandboxEgressId() {
      // Vercel Sandbox v2 names the persistent sandbox separately from the
      // running VM session identified by firewall proxy OIDC tokens.
      return sandbox.currentSession().sessionId;
    },
    fs: sandbox.fs as SandboxFileSystem,
    extendTimeout(duration) {
      return sandbox.extendTimeout(duration);
    },
    mkDir(path) {
      return sandbox.mkDir(path);
    },
    readFileToBuffer(input) {
      return sandbox.readFileToBuffer(input);
    },
    runCommand(input) {
      return sandbox.runCommand(input);
    },
    async snapshot() {
      const snapshot = await sandbox.snapshot();
      return { snapshotId: snapshot.snapshotId };
    },
    stop() {
      return sandbox.stop();
    },
    update(params) {
      return sandbox.update(params);
    },
    writeFiles(files) {
      return sandbox.writeFiles(files);
    },
  };
}
