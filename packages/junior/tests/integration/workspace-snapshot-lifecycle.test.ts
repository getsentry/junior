import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/chat/db";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import { hash as workspaceProfileHash } from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { loadSnapshotsForProfile } from "@/chat/sandbox/snapshot/store";
import { isWorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { getWorkspace } from "@/chat/workspaces/store";
import type {
  Workspace,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";
import { juniorWorkspaces } from "@/db/schema";

const MARKER_PATH = `${SANDBOX_WORKSPACE_ROOT}/marker/setup.txt`;
/** Cold builds install the global Sandbox runtime dependencies, including Docker. */
const LIVE_TEST_TIMEOUT_MS = 40 * 60 * 1000;

function sandboxCredentialsReady(): boolean {
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) return true;
  return Boolean(
    process.env.VERCEL_TOKEN?.trim() &&
    process.env.VERCEL_TEAM_ID?.trim() &&
    process.env.VERCEL_PROJECT_ID?.trim(),
  );
}

function setupScript(): string {
  return [
    "set -euo pipefail",
    `mkdir -p "${SANDBOX_WORKSPACE_ROOT}/marker"`,
    `printf '%s\\n' 'ready' > "${MARKER_PATH}"`,
  ].join("\n");
}

async function stopNamedSandbox(name: string | null): Promise<void> {
  if (!name) return;
  try {
    const credentials = getVercelSandboxCredentials();
    const sandbox = await Sandbox.get({
      name,
      resume: true,
      ...(credentials ?? {}),
    });
    await sandbox.stop();
  } catch {
    // Snapshot creation or a failed provider start may already stop the builder.
  }
}

function profileHash(workspace: Workspace): string {
  const hash = workspaceProfileHash(SANDBOX_RUNTIME, workspace);
  if (!hash) throw new Error(`Workspace ${workspace.name} has no profile`);
  return hash;
}

async function loadBuild(
  workspace: Workspace,
): Promise<WorkspaceSnapshotBuild | null> {
  return (
    await loadSnapshotsForProfile(getDb(), workspace.id, profileHash(workspace))
  ).build;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Start until SQL contains the checkpoint needed by the next execution slice. */
async function startUntilBuildingCheckpoint(
  workspaceId: string,
): Promise<{ build: WorkspaceSnapshotBuild; workspace: Workspace }> {
  const deadlineAtMs = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadlineAtMs) {
    const workspace = (await getWorkspace(getDb(), workspaceId))!;
    const runtime = createSandboxRuntime({
      workspace,
      skills: [],
      referenceFiles: [],
      shouldYield: () => true,
    });
    try {
      await expect(runtime.acquire()).rejects.toSatisfy(
        isWorkspaceSnapshotWaitingError,
      );
    } finally {
      runtime.close();
    }

    const build = await loadBuild(workspace);
    if (build?.status === "building" && build.sandboxName) {
      return { build, workspace };
    }
    await sleep(2_000);
  }
  throw new Error(
    `Workspace ${workspaceId} did not reach a durable building checkpoint`,
  );
}

/**
 * Use the real Vercel provider for the durable Workspace snapshot boundary.
 * The test skips for local and fork runs that do not have provider credentials.
 */
describe.skipIf(!sandboxCredentialsReady())(
  "Workspace snapshot lifecycle",
  () => {
    const builderNames: string[] = [];

    beforeEach(async () => {
      await getStateAdapter().connect();
    });

    afterEach(async () => {
      for (const name of builderNames.splice(0)) {
        await stopNamedSandbox(name);
      }
      await disconnectStateAdapter();
    });

    it(
      "resumes a cold build from its SQL checkpoint and boots the snapshot",
      async () => {
        const workspaceId = randomUUID();
        const now = new Date();
        await getDb()
          .insert(juniorWorkspaces)
          .values({
            id: workspaceId,
            name: `snapshot-lifecycle-${workspaceId.slice(0, 8)}`,
            setupScript: setupScript(),
            createdAt: now,
            updatedAt: now,
          });

        const started = await startUntilBuildingCheckpoint(workspaceId);
        builderNames.push(started.build.sandboxName!);
        expect(started.build).toMatchObject({
          status: "building",
          phase: "created",
          commandId: null,
        });

        const runtime = createSandboxRuntime({
          workspace: (await getWorkspace(getDb(), workspaceId))!,
          skills: [],
          referenceFiles: [],
          shouldYield: () => false,
        });
        try {
          const session = await runtime.acquire();
          try {
            const state = await loadSnapshotsForProfile(
              getDb(),
              workspaceId,
              profileHash(started.workspace),
            );
            expect(state.build).toBeNull();
            expect(state.ready?.id).toBeTruthy();
            expect(runtime.sandboxRef()).toMatchObject({
              profileHash: state.ready?.profileHash,
              workspaceId,
            });

            const marker = await session.runCommand({
              cmd: "cat",
              args: [MARKER_PATH],
            });
            expect(marker).toMatchObject({ exitCode: 0, stdout: "ready\n" });
          } finally {
            await session.stop().catch(() => undefined);
          }
        } finally {
          runtime.close();
        }
      },
      LIVE_TEST_TIMEOUT_MS,
    );
  },
);
