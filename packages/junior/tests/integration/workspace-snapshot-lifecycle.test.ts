import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/chat/db";
import { getVercelSandboxCredentials } from "@/chat/sandbox/credentials";
import { SANDBOX_WORKSPACE_ROOT } from "@/chat/sandbox/paths";
import { createSandboxRuntime } from "@/chat/sandbox/session";
import { isWorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import {
  disconnectStateAdapter,
  getStateAdapter,
} from "@/chat/state/adapter";
import { getWorkspace, updateWorkspace } from "@/chat/workspaces/store";
import { juniorWorkspaces } from "@/db/schema";

const ORIGINAL_ENV = { ...process.env };
const MARKER_PATH = `${SANDBOX_WORKSPACE_ROOT}/marker/setup.txt`;
const LIVE_TEST_TIMEOUT_MS = 20 * 60 * 1000;

function sandboxCredentialsReady(): boolean {
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) return true;
  return Boolean(
    process.env.VERCEL_TOKEN?.trim() &&
      process.env.VERCEL_TEAM_ID?.trim() &&
      process.env.VERCEL_PROJECT_ID?.trim(),
  );
}

function setupScript(label: string): string {
  return [
    "set -euo pipefail",
    `mkdir -p "${SANDBOX_WORKSPACE_ROOT}/marker"`,
    `printf '%s\\n' '${label}' > "${MARKER_PATH}"`,
  ].join("\n");
}

async function stopNamedSandbox(
  name: string | null | undefined,
): Promise<void> {
  if (!name) return;
  try {
    const credentials = getVercelSandboxCredentials();
    const sandbox = await Sandbox.get({
      name,
      resume: false,
      ...(credentials ?? {}),
    });
    await sandbox.stop();
  } catch {
    // Builder may already be stopped after snapshot or a failed start.
  }
}

async function stopWorkspaceBuilders(workspaceId: string): Promise<void> {
  const workspace = await getWorkspace(getDb(), workspaceId);
  await stopNamedSandbox(workspace?.snapshotBuild?.sandboxName);
}

async function readMarker(
  session: Awaited<ReturnType<ReturnType<typeof createSandboxRuntime>["acquire"]>>,
): Promise<string> {
  const result = await session.runCommand({
    cmd: "cat",
    args: [MARKER_PATH],
  });
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

/**
 * Real Vercel Sandbox proof for the durable workspace snapshot control plane.
 * Integration may only fake Slack + LLMs — not @vercel/sandbox.
 * Skips when sandbox credentials are absent (local/fork); CI injects them.
 */
describe.skipIf(!sandboxCredentialsReady())(
  "Workspace snapshot lifecycle",
  () => {
    const trackedWorkspaceIds: string[] = [];

    beforeEach(async () => {
      process.env = {
        ...ORIGINAL_ENV,
        JUNIOR_STATE_ADAPTER: "memory",
      };
      await getStateAdapter().connect();
    });

    afterEach(async () => {
      for (const workspaceId of trackedWorkspaceIds.splice(0)) {
        await stopWorkspaceBuilders(workspaceId);
      }
      await disconnectStateAdapter();
      process.env = { ...ORIGINAL_ENV };
    });

    it(
      "continues a cold build across check-ins and boots its ready snapshot",
      async () => {
        const now = new Date();
        const workspaceId = randomUUID();
        trackedWorkspaceIds.push(workspaceId);
        const db = getDb();
        await db.insert(juniorWorkspaces).values({
          id: workspaceId,
          name: `snapshot-lifecycle-${workspaceId.slice(0, 8)}`,
          setupScript: setupScript("ready"),
          createdAt: now,
          updatedAt: now,
        });

        const workspace = (await getWorkspace(db, workspaceId))!;
        // One slice per acquire so SQL phase advances are visible.
        const slicing = createSandboxRuntime({
          workspace,
          skills: [],
          referenceFiles: [],
          shouldYield: () => true,
        });

        try {
          for (const phase of [
            "created",
            "dependencies_installed",
            "repositories_prepared",
          ] as const) {
            await expect(slicing.acquire()).rejects.toSatisfy(
              isWorkspaceSnapshotWaitingError,
            );
            const current = await getWorkspace(db, workspaceId);
            expect(current?.snapshotBuild?.status).toBe("building");
            expect(current?.snapshotBuild?.phase).toBe(phase);
            expect(current?.snapshotBuild?.sandboxName).toBeTruthy();
            expect(current?.snapshotBuild?.commandId).toBeNull();
          }

          // Detach setup on the next slice, then poll until ready and boot.
          const finishing = createSandboxRuntime({
            workspace: (await getWorkspace(db, workspaceId))!,
            skills: [],
            referenceFiles: [],
            shouldYield: () => false,
          });
          try {
            const session = await finishing.acquire();
            try {
              const ready = await getWorkspace(db, workspaceId);

              expect(ready?.snapshotBuild).toBeNull();
              expect(ready?.snapshot?.id).toBeTruthy();
              expect(ready?.snapshot?.runtime).toBe("node22");
              expect(finishing.sandboxRef()).toMatchObject({
                profileHash: ready?.snapshot?.profileHash,
                workspaceId,
              });
              expect(await readMarker(session)).toBe("ready");
            } finally {
              await session.stop().catch(() => undefined);
            }
          } finally {
            finishing.close();
          }
        } finally {
          slicing.close();
        }
      },
      LIVE_TEST_TIMEOUT_MS,
    );

    it(
      "reuses a retained ready snapshot when setup script reverts",
      async () => {
        const now = new Date();
        const workspaceId = randomUUID();
        trackedWorkspaceIds.push(workspaceId);
        const db = getDb();
        await db.insert(juniorWorkspaces).values({
          id: workspaceId,
          name: `snapshot-reuse-${workspaceId.slice(0, 8)}`,
          setupScript: setupScript("alpha"),
          createdAt: now,
          updatedAt: now,
        });

        const recipeA = (await getWorkspace(db, workspaceId))!;
        let snapshotIdA = "";
        let profileHashA = "";

        const buildA = createSandboxRuntime({
          workspace: recipeA,
          skills: [],
          referenceFiles: [],
          shouldYield: () => false,
        });
        try {
          const sessionA = await buildA.acquire();
          try {
            const readyA = await getWorkspace(db, workspaceId);
            expect(readyA?.snapshot?.id).toBeTruthy();
            snapshotIdA = readyA!.snapshot!.id;
            profileHashA = readyA!.snapshot!.profileHash;
            expect(await readMarker(sessionA)).toBe("alpha");
          } finally {
            await sessionA.stop().catch(() => undefined);
          }
        } finally {
          buildA.close();
        }

        await updateWorkspace(workspaceId, {
          name: recipeA.name,
          setupScript: setupScript("beta"),
          repos: [],
        });
        const recipeB = (await getWorkspace(db, workspaceId))!;
        // Start B only far enough to prove it is a different profile build.
        const startB = createSandboxRuntime({
          workspace: recipeB,
          skills: [],
          referenceFiles: [],
          shouldYield: () => true,
        });
        try {
          await expect(startB.acquire()).rejects.toSatisfy(
            isWorkspaceSnapshotWaitingError,
          );
          const buildingB = await getWorkspace(db, workspaceId);
          expect(buildingB?.snapshotBuild?.status).toBe("building");
          expect(buildingB?.snapshotBuild?.profileHash).not.toBe(profileHashA);
          // Ready A stays while B builds.
          expect(buildingB?.snapshot?.id).toBe(snapshotIdA);
        } finally {
          startB.close();
          await stopWorkspaceBuilders(workspaceId);
        }

        await updateWorkspace(workspaceId, {
          name: recipeA.name,
          setupScript: recipeA.setupScript,
          repos: [],
        });
        const reverted = (await getWorkspace(db, workspaceId))!;
        const reuse = createSandboxRuntime({
          workspace: reverted,
          skills: [],
          referenceFiles: [],
          shouldYield: () => false,
        });
        try {
          const session = await reuse.acquire();
          try {
            const ready = await getWorkspace(db, workspaceId);

            expect(ready?.snapshot?.id).toBe(snapshotIdA);
            expect(ready?.snapshot?.profileHash).toBe(profileHashA);
            expect(ready?.snapshotBuild).toBeNull();
            expect(reuse.sandboxRef()).toMatchObject({
              profileHash: profileHashA,
              workspaceId,
            });
            expect(await readMarker(session)).toBe("alpha");
          } finally {
            await session.stop().catch(() => undefined);
          }
        } finally {
          reuse.close();
        }
      },
      LIVE_TEST_TIMEOUT_MS,
    );
  },
);
