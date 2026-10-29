import { FileSystem, Sandbox } from "@vercel/sandbox";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import {
  isSandboxMissingError,
  isSandboxUnavailableError,
} from "@/chat/sandbox/errors";
import type {
  SandboxCommandInput,
  SandboxFileSystem,
  SandboxNetworkPolicy,
  SandboxSession,
} from "@/chat/sandbox/workspace";

// Module overview: the only module that calls the Vercel Sandbox SDK.
//
// Callers use provider-neutral inputs and `SandboxSession`. Vercel names,
// credentials, request options, and SDK objects stay in this file.

interface SessionOptions {
  /** Called when a session operation finds that the VM session is gone. */
  onUnavailable?: (sessionId: string) => void;
  /** Abort every provider request made through the returned session. */
  scopeSignal?: AbortSignal;
}

/** Input for one new Sandbox. */
export interface CreateSandboxSessionInput extends SessionOptions {
  name?: string;
  persistent?: boolean;
  /** Runtime image for a new Sandbox. Unused when `snapshotId` is set. */
  runtime?: string;
  /** Boot from this snapshot instead of an empty runtime image. */
  snapshotId?: string;
  timeoutMs: number;
  networkPolicy?: SandboxNetworkPolicy;
  resources?: { vcpus: number };
  /** Abort only the create request. */
  signal?: AbortSignal;
}

/** Saved Workspace snapshot builder Sandbox that one build job can continue. */
export interface WorkspaceSnapshotBuilder {
  /** Session pinned to the current VM session, without SDK replay. */
  session(): SandboxSession;
  /** Start a command that keeps running after this request ends. */
  startDetachedCommand(input: SandboxCommandInput): Promise<string>;
  /** Wait for a detached command that an earlier job started. */
  waitForCommand(
    commandId: string,
    options: { signal?: AbortSignal; waitSignal: AbortSignal },
  ): Promise<{
    exitCode: number;
    stdout(): Promise<string>;
    stderr(): Promise<string>;
  }>;
  snapshot(options?: {
    signal?: AbortSignal;
  }): Promise<{ snapshotId: string; sizeBytes?: number }>;
}

function credentialOptions() {
  return getVercelSandboxCredentials() ?? {};
}

/** Bind one abort signal to every API request made by a Sandbox client. */
function scopedFetchOptions(
  signal?: AbortSignal,
): { fetch: typeof globalThis.fetch } | Record<string, never> {
  if (!signal) return {};
  return {
    fetch: (input, init) => {
      const requestSignal =
        init?.signal ?? (input instanceof Request ? input.signal : undefined);
      return globalThis.fetch(input, {
        ...init,
        signal: requestSignal
          ? AbortSignal.any([requestSignal, signal])
          : signal,
      });
    },
  };
}

/** Pin Junior's sandbox contract to one Vercel session without SDK replay. */
function adaptSession(
  sandbox: Sandbox,
  options?: SessionOptions,
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
    snapshot(snapshotOptions) {
      return run(async () => {
        const snapshot = await session.snapshot(snapshotOptions);
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

/** Create a Sandbox and return a session pinned to its first VM session. */
export async function createSandboxSession(
  input: CreateSandboxSessionInput,
): Promise<SandboxSession> {
  const shared = {
    timeout: input.timeoutMs,
    ...(input.name ? { name: input.name } : undefined),
    ...(input.persistent !== undefined
      ? { persistent: input.persistent }
      : undefined),
    ...(input.networkPolicy
      ? { networkPolicy: input.networkPolicy }
      : undefined),
    ...(input.resources ? { resources: input.resources } : undefined),
    ...(input.signal ? { signal: input.signal } : undefined),
    ...credentialOptions(),
    ...scopedFetchOptions(input.scopeSignal),
  };
  const sandbox = await Sandbox.create(
    input.snapshotId
      ? {
          ...shared,
          source: { type: "snapshot", snapshotId: input.snapshotId },
        }
      : {
          ...shared,
          ...(input.runtime ? { runtime: input.runtime } : undefined),
        },
  );
  return adaptSession(sandbox, input);
}

/** Resume a named Sandbox and return a session pinned to its VM session. */
export async function getSandboxSession(
  input: { name: string } & SessionOptions,
): Promise<SandboxSession> {
  const sandbox = await Sandbox.get({
    name: input.name,
    resume: true,
    ...credentialOptions(),
    ...scopedFetchOptions(input.scopeSignal),
  });
  return adaptSession(sandbox, input);
}

/** Create the named, persistent Sandbox that owns one Workspace snapshot build. */
export async function createWorkspaceSnapshotBuilder(input: {
  name: string;
  runtime: string;
  timeoutMs: number;
  resources?: { vcpus: number };
  signal?: AbortSignal;
}): Promise<void> {
  await Sandbox.create({
    name: input.name,
    persistent: true,
    timeout: input.timeoutMs,
    runtime: input.runtime,
    signal: input.signal,
    ...credentialOptions(),
    ...(input.resources ? { resources: input.resources } : undefined),
  });
}

/** Resume the named Sandbox that owns one Workspace snapshot build. */
export async function getWorkspaceSnapshotBuilder(
  name: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshotBuilder> {
  const sandbox = await Sandbox.get({
    name,
    resume: true,
    signal,
    ...credentialOptions(),
  });
  return {
    session: () => adaptSession(sandbox),
    async startDetachedCommand(input) {
      const command = await sandbox.runCommand({ ...input, detached: true });
      return command.cmdId;
    },
    async waitForCommand(commandId, options) {
      const command = await sandbox.getCommand(commandId, {
        signal: options.signal,
      });
      const finished = await command.wait({ signal: options.waitSignal });
      return {
        exitCode: finished.exitCode,
        stdout: () => finished.stdout({ signal: options.signal }),
        stderr: () => finished.stderr({ signal: options.signal }),
      };
    },
    async snapshot(options) {
      const snapshot = await sandbox.snapshot(options);
      return {
        snapshotId: snapshot.snapshotId,
        ...(typeof snapshot.sizeBytes === "number"
          ? { sizeBytes: snapshot.sizeBytes }
          : undefined),
      };
    },
  };
}

/** Permanently delete named Workspace snapshot builders without resuming them. */
export async function deleteWorkspaceSnapshotBuilders(
  names: Iterable<string>,
): Promise<void> {
  let hasError = false;
  let firstError: unknown;
  for (const name of new Set(names)) {
    try {
      const sandbox = await Sandbox.get({
        name,
        resume: false,
        ...credentialOptions(),
      });
      await sandbox.delete();
    } catch (error) {
      if (!isSandboxMissingError(error)) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    }
  }
  if (hasError) throw firstError;
}
