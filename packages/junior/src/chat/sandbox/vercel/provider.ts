import { FileSystem, Sandbox } from "@vercel/sandbox";
import { getVercelSandboxCredentials } from "@/chat/sandbox/vercel/credentials";
import { toVercelNetworkPolicy } from "@/chat/sandbox/egress/vercel";
import { vercelSandboxErrors } from "@/chat/sandbox/vercel/errors";
import { sessionCost } from "@/chat/sandbox/vercel/pricing";
import type { SandboxProvider } from "@/chat/sandbox/provider";
import type {
  CreateWorkspaceSnapshotBuilderInput,
  WorkspaceSnapshotBuilder,
} from "@/chat/sandbox/snapshot/workspace";
import type {
  CreateSandboxSessionInput,
  SandboxFileSystem,
  SandboxSession,
  SandboxSessionCost,
  SandboxSessionOptions,
} from "@/chat/sandbox/workspace";

/**
 * Sandbox client options. Since 4.0, a client without `fetch` uses the SDK's
 * own undici `fetch` and skips process-level `fetch` replacements, such as the
 * eval proxy. So every request reads `globalThis.fetch` when it starts, and
 * the scope signal, when there is one, can abort it.
 */
function clientOptions(signal?: AbortSignal) {
  const fetch: typeof globalThis.fetch = (input, init) => {
    if (!signal) return globalThis.fetch(input, init);
    const requestSignal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return globalThis.fetch(input, {
      ...init,
      signal: requestSignal ? AbortSignal.any([requestSignal, signal]) : signal,
    });
  };
  return { ...getVercelSandboxCredentials(), fetch };
}

/** Pin Junior's sandbox contract to one Vercel session without SDK replay. */
function adaptSession(
  sandbox: Sandbox,
  options?: SandboxSessionOptions,
  createdSandbox = false,
): SandboxSession {
  // Pin operations to the acquired VM session. The Sandbox convenience methods
  // may resume and replay an operation after a lifecycle failure.
  const session = sandbox.currentSession();
  const fileSystem = new FileSystem(session);
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (vercelSandboxErrors.isUnavailable(error)) {
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
    createPreview(port) {
      return run(async () => {
        // `ports` replaces the whole list, so keep the routes that exist.
        const ports = new Set(session.routes.map((route) => route.port));
        if (!ports.has(port)) {
          await sandbox.update({ ports: [...ports, port] });
        }
        return session.domain(port);
      });
    },
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
      return run(async () => {
        // Stop waits for shutdown, so the final record carries the usage.
        const stopped = await session.stop();
        return sessionCost(stopped.session, createdSandbox);
      });
    },
    update(params) {
      return run(
        async () =>
          await session.update(
            params.networkPolicy
              ? { networkPolicy: toVercelNetworkPolicy(params.networkPolicy) }
              : {},
          ),
      );
    },
    writeFiles(files) {
      return run(async () => await session.writeFiles(files));
    },
  };
}

/** Create a Sandbox and return a session pinned to its first VM session. */
async function createSandboxSession(
  input: CreateSandboxSessionInput,
): Promise<SandboxSession> {
  const shared = {
    timeout: input.timeoutMs,
    ...(input.name ? { name: input.name } : undefined),
    ...(input.persistent !== undefined
      ? { persistent: input.persistent }
      : undefined),
    ...(input.networkPolicy
      ? { networkPolicy: toVercelNetworkPolicy(input.networkPolicy) }
      : undefined),
    ...(input.resources ? { resources: input.resources } : undefined),
    ...(input.signal ? { signal: input.signal } : undefined),
    ...clientOptions(input.scopeSignal),
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
  return adaptSession(sandbox, input, true);
}

/** Resume a named Sandbox and return a session pinned to its VM session. */
async function getSandboxSession(
  input: { name: string } & SandboxSessionOptions,
): Promise<SandboxSession> {
  const sandbox = await Sandbox.get({
    name: input.name,
    resume: true,
    ...clientOptions(input.scopeSignal),
  });
  return adaptSession(sandbox, input);
}

/** Create the named, persistent Sandbox that owns one Workspace snapshot build. */
async function createWorkspaceSnapshotBuilder(
  input: CreateWorkspaceSnapshotBuilderInput,
): Promise<void> {
  await Sandbox.create({
    name: input.name,
    persistent: true,
    timeout: input.timeoutMs,
    runtime: input.runtime,
    signal: input.signal,
    ...clientOptions(),
    ...(input.resources ? { resources: input.resources } : undefined),
  });
}

/** Resume the named Sandbox that owns one Workspace snapshot build. */
async function getWorkspaceSnapshotBuilder(
  name: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshotBuilder> {
  const sandbox = await Sandbox.get({
    name,
    resume: true,
    signal,
    ...clientOptions(),
  });
  return {
    session: () => adaptSession(sandbox),
    async startDetachedCommand(input) {
      const command = await sandbox.runCommand({ ...input, detached: true });
      return command.cmdId;
    },
    getCommand: (commandId, options) => sandbox.getCommand(commandId, options),
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
async function deleteWorkspaceSnapshotBuilders(
  names: Iterable<string>,
): Promise<void> {
  let hasError = false;
  let firstError: unknown;
  for (const name of new Set(names)) {
    try {
      const sandbox = await Sandbox.get({
        name,
        resume: false,
        ...clientOptions(),
      });
      await sandbox.delete();
    } catch (error) {
      if (!vercelSandboxErrors.isMissing(error)) {
        if (!hasError) firstError = error;
        hasError = true;
      }
    }
  }
  if (hasError) throw firstError;
}

/** Read the cost of one session from the Sandbox's session records. */
async function readSessionCost(input: {
  sandboxId: string;
  sessionId: string;
  createdSandbox: boolean;
  signal?: AbortSignal;
}): Promise<SandboxSessionCost> {
  let sandbox: Sandbox;
  try {
    sandbox = await Sandbox.get({
      name: input.sandboxId,
      resume: false,
      signal: input.signal,
      ...clientOptions(input.signal),
    });
  } catch (error) {
    // Vercel removes a non-persistent Sandbox after 14 days without use.
    if (vercelSandboxErrors.isMissing(error)) return { status: "missing" };
    throw error;
  }
  const sessions = await sandbox.listSessions({
    sortOrder: "desc",
    signal: input.signal,
  });
  for await (const session of sessions) {
    if (session.id === input.sessionId) {
      return sessionCost(session, input.createdSandbox);
    }
  }
  return { status: "missing" };
}

/** Vercel Sandbox implementation of the sandbox provider contract. */
export const vercelSandboxProvider: SandboxProvider = {
  errors: vercelSandboxErrors,
  createSession: createSandboxSession,
  getSession: getSandboxSession,
  createWorkspaceSnapshotBuilder,
  getWorkspaceSnapshotBuilder,
  deleteWorkspaceSnapshotBuilders,
  readSessionCost,
};
