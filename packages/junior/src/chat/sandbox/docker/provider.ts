import { DockerApiError, dockerRequest } from "@/chat/sandbox/docker/api";
import {
  createContainer,
  getContainer,
  newSandboxName,
  removeContainer,
} from "@/chat/sandbox/docker/container";
import { applyEgressPolicy, egressCaPem } from "@/chat/sandbox/docker/egress";
import { dockerSandboxErrors } from "@/chat/sandbox/docker/errors";
import {
  startDetachedCommand,
  waitForDetachedCommand,
} from "@/chat/sandbox/docker/exec";
import { ensureRuntimeImage } from "@/chat/sandbox/docker/runtime-image";
import {
  adaptSession,
  commitSnapshot,
  SNAPSHOT_REPOSITORY,
} from "@/chat/sandbox/docker/session";
import type { SandboxProvider, SnapshotRuntime } from "@/chat/sandbox/provider";
import type {
  CreateWorkspaceSnapshotBuilderInput,
  WorkspaceSnapshotBuilder,
} from "@/chat/sandbox/snapshot/workspace";
import type {
  CreateSandboxSessionInput,
  SandboxSession,
  SandboxSessionOptions,
} from "@/chat/sandbox/workspace";

/** Create a sandbox container and return a session for it. */
async function createSession(
  input: CreateSandboxSessionInput,
): Promise<SandboxSession> {
  const image =
    input.snapshotId ??
    (await ensureRuntimeImage(input.runtime ?? "node22", input.signal));
  const container = await createContainer(
    {
      name: input.name ?? newSandboxName(),
      image,
      timeoutMs: input.timeoutMs,
      persistent: input.persistent ?? false,
      vcpus: input.resources?.vcpus,
      signal: input.signal,
    },
    await egressCaPem(),
  );
  try {
    if (input.networkPolicy) {
      await applyEgressPolicy(container, input.networkPolicy);
    }
  } catch (error) {
    await removeContainer(container.name).catch(() => undefined);
    throw error;
  }
  return adaptSession(container, input);
}

/** Return a session for a named sandbox container. Start it if it stopped. */
async function getSession(
  input: { name: string } & SandboxSessionOptions,
): Promise<SandboxSession> {
  const container = await getContainer(
    input.name,
    await egressCaPem(),
    input.scopeSignal,
  );
  return adaptSession(container, input);
}

/** Create the persistent container that runs one Workspace snapshot build. */
async function createWorkspaceSnapshotBuilder(
  input: CreateWorkspaceSnapshotBuilderInput,
): Promise<void> {
  await createContainer(
    {
      name: input.name,
      image: await ensureRuntimeImage(input.runtime, input.signal),
      timeoutMs: input.timeoutMs,
      persistent: true,
      vcpus: input.resources?.vcpus,
      signal: input.signal,
    },
    await egressCaPem(),
  );
}

/**
 * Return the container that runs one Workspace snapshot build.
 *
 * A Docker snapshot is an image that does not depend on its builder. So
 * `snapshot()` removes the builder right after the commit, and the image tag
 * keeps the builder's name. Deleting the builder later removes that tag.
 */
async function getWorkspaceSnapshotBuilder(
  name: string,
  signal?: AbortSignal,
): Promise<WorkspaceSnapshotBuilder> {
  const container = await getContainer(name, await egressCaPem(), signal);
  return {
    session: () => adaptSession(container),
    startDetachedCommand: (input) => startDetachedCommand(container.id, input),
    async getCommand(commandId) {
      return {
        wait: ({ signal: waitSignal }) =>
          waitForDetachedCommand(container.id, commandId, waitSignal),
      };
    },
    async snapshot(options) {
      const snapshotId = await commitSnapshot(
        container.id,
        name,
        options?.signal,
      );
      await removeContainer(name);
      return { snapshotId };
    },
  };
}

async function deleteSnapshotTag(name: string): Promise<void> {
  try {
    // `force` removes only the tag while running sandboxes still use the
    // image. Docker frees the image when its last container goes away.
    await dockerRequest({
      method: "DELETE",
      path: `/images/${encodeURIComponent(`${SNAPSHOT_REPOSITORY}:${name}`)}`,
      query: { force: true },
    });
  } catch (error) {
    if (!(error instanceof DockerApiError && error.statusCode === 404)) {
      throw error;
    }
  }
}

/**
 * Remove Workspace builders and the snapshot images tagged with their names.
 *
 * Shared snapshot code calls this when a Workspace snapshot is no longer
 * used. Each name is tried, and the first failure is thrown at the end.
 */
async function deleteWorkspaceSnapshotBuilders(
  names: Iterable<string>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const name of new Set(names)) {
    for (const remove of [removeContainer, deleteSnapshotTag]) {
      try {
        await remove(name);
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length > 0) throw failures[0];
}

// Docker sandboxes are for local development. They install only these tools,
// so the snapshot stays small and builds fast. The agent installs other tools
// when it needs them. `spal-release` adds the repository for `ripgrep`.
const DOCKER_SNAPSHOT_PACKAGES = new Set([
  "spal-release",
  "ripgrep",
  "gh",
  "jq",
]);

/**
 * Keep only the small Docker base from the declared runtime dependencies.
 *
 * Postinstall commands are skipped, because they often download large tools.
 * A base package that no plugin declares is not installed.
 */
function selectSnapshotRuntime(runtime: SnapshotRuntime): SnapshotRuntime {
  return {
    dependencies: runtime.dependencies.filter(
      (dependency) =>
        "package" in dependency &&
        DOCKER_SNAPSHOT_PACKAGES.has(dependency.package),
    ),
    postinstall: [],
  };
}

/** Local Docker implementation of the sandbox provider contract. */
export const dockerSandboxProvider: SandboxProvider = {
  errors: dockerSandboxErrors,
  createSession,
  getSession,
  createWorkspaceSnapshotBuilder,
  getWorkspaceSnapshotBuilder,
  deleteWorkspaceSnapshotBuilders,
  selectSnapshotRuntime,
};
