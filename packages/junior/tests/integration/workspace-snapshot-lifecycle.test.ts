import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/chat/db";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import { deleteWorkspaceSnapshotBuilders } from "@/chat/sandbox/snapshot/builder-sandbox";
import { processWorkspaceSnapshotJob } from "@/chat/sandbox/snapshot/job-runner";
import { hash as workspaceProfileHash } from "@/chat/sandbox/snapshot/profile";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import { loadSnapshotsForProfile } from "@/chat/sandbox/snapshot/store";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createWorkspace, getWorkspace } from "@/chat/workspaces/store";
import type { Workspace } from "@/chat/workspaces/types";

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

/**
 * Build a Workspace snapshot with Vercel, then start a Sandbox from it.
 * Skip this test when Vercel credentials are not available.
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
      "builds a snapshot on the job path and boots it through switch/acquire",
      async () => {
        const workspace = await createWorkspace({
          name: `snapshot-lifecycle-${randomUUID()}`,
          setupScript: setupScript(),
          repos: [],
        });
        const workspaceId = workspace.id;
        const hash = profileHash(workspace);

        await processWorkspaceSnapshotJob({
          workspaceId,
          profileHash: hash,
        });

        const state = await loadSnapshotsForProfile(getDb(), workspaceId, hash);
        expect(state.build).toBeNull();
        expect(state.ready?.id).toBeTruthy();

        const runtime = createSandboxRuntime({
          workspace: (await getWorkspace(getDb(), workspaceId))!,
          skills: [],
          referenceFiles: [],
        });
        try {
          const session = await runtime.acquire();
          try {
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
