import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/chat/db";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import { deleteWorkspaceSnapshotBuilders } from "@/chat/sandbox/snapshot/builder-sandbox";
import { hash as workspaceProfileHash } from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { loadSnapshotsForProfile } from "@/chat/sandbox/snapshot/store";
import { isWorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createWorkspace, getWorkspace } from "@/chat/workspaces/store";
import type {
  Workspace,
  WorkspaceSnapshotBuild,
} from "@/chat/workspaces/types";

const MARKER_PATH = `${SANDBOX_WORKSPACE_ROOT}/marker/setup.txt`;
/** Fail a cold build that exceeds the production phase limit. */
const LIVE_TEST_TIMEOUT_MS = 10 * 60 * 1000;

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
      shouldYield: (() => {
        let checks = 0;
        return () => {
          checks += 1;
          return checks > 1;
        };
      })(),
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
      try {
        await deleteWorkspaceSnapshotBuilders(builderNames.splice(0));
      } finally {
        await disconnectStateAdapter();
      }
    });

    it(
      "resumes a cold build from its SQL checkpoint and boots the snapshot",
      async () => {
        const workspace = await createWorkspace({
          name: `snapshot-lifecycle-${randomUUID()}`,
          setupScript: setupScript(),
          repos: [],
        });
        const workspaceId = workspace.id;

        const started = await startUntilBuildingCheckpoint(workspaceId);
        builderNames.push(started.build.sandboxName!);
        expect(started.build).toMatchObject({
          status: "building",
          profileHash: profileHash(started.workspace),
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
