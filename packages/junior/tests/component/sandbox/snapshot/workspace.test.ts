import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxCreateMock, sandboxGetMock } = vi.hoisted(() => ({
  sandboxCreateMock: vi.fn(),
  sandboxGetMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  FileSystem: class {},
  Sandbox: {
    create: sandboxCreateMock,
    get: sandboxGetMock,
  },
}));

import { closeDb, getDb } from "@/chat/db";
import { FUNCTION_TIMEOUT_BUFFER_SECONDS, getChatConfig } from "@/chat/config";
import { runWithTurnRequestDeadline } from "@/chat/runtime/request-deadline";
import { deleteWorkspaceSnapshotBuilders } from "@/chat/sandbox/snapshot/builder-sandbox";
import * as profile from "@/chat/sandbox/snapshot/profile";
import { getCachedSnapshot } from "@/chat/sandbox/snapshot/resolve";
import { SANDBOX_RUNTIME } from "@/chat/sandbox/snapshot/runtime";
import {
  loadSnapshotsForProfile,
  setWorkspaceSnapshotBuild,
} from "@/chat/sandbox/snapshot/store";
import { isWorkspaceSnapshotWaitingError } from "@/chat/sandbox/snapshot/waiting-error";
import { resolveWorkspaceSnapshot } from "@/chat/sandbox/snapshot/workspace";
import { disconnectStateAdapter, getStateAdapter } from "@/chat/state/adapter";
import { createWorkspace } from "@/chat/workspaces/store";
import { juniorSnapshots } from "@/db/schema";

const abortSignalTimeout = AbortSignal.timeout.bind(AbortSignal);

describe("Workspace snapshot completion", () => {
  beforeEach(() => {
    sandboxCreateMock.mockReset();
    sandboxGetMock.mockReset();
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    await closeDb();
  });

  it("stores a completed snapshot only in SQL and keeps its owner", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-cleanup-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    const buildId = randomUUID();
    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: buildId,
        status: "building",
        phase: "repositories_prepared",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "snapshot-owner",
        commandId: "setup-command",
        error: null,
      },
      { insertIfMissing: true },
    );

    const builder = {
      delete: vi.fn(),
      getCommand: vi.fn(async () => ({
        wait: vi.fn(async () => ({ exitCode: 0 })),
      })),
      snapshot: vi.fn(async () => ({ snapshotId: "snapshot-ready" })),
    };
    sandboxGetMock.mockResolvedValue(builder);

    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => false,
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).resolves.toMatchObject({ snapshotId: "snapshot-ready" });

    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: null,
      ready: { id: "snapshot-ready" },
    });
    await expect(getCachedSnapshot(value.hash)).resolves.toBeNull();
    await expect(
      getDb()
        .select({ sandboxName: juniorSnapshots.buildSandboxName })
        .from(juniorSnapshots)
        .where(eq(juniorSnapshots.id, buildId)),
    ).resolves.toEqual([{ sandboxName: "snapshot-owner" }]);
    expect(builder.delete).not.toHaveBeenCalled();
  });

  it("starts a rebuild when failed-builder deletion fails", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-rebuild-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: randomUUID(),
        status: "failed",
        phase: "created",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "failed-builder-cleanup-fails",
        commandId: null,
        error: "install failed",
      },
      { insertIfMissing: true },
    );
    sandboxGetMock.mockRejectedValue(new Error("Vercel cleanup failed"));
    sandboxCreateMock.mockResolvedValue({});
    let yieldChecks = 0;

    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => {
          yieldChecks += 1;
          return yieldChecks > 1;
        },
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).rejects.toSatisfy(isWorkspaceSnapshotWaitingError);

    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: { status: "building" },
      ready: null,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("marks a build failed when its named builder is missing", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-missing-builder-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: randomUUID(),
        status: "building",
        phase: "created",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "missing-builder",
        commandId: null,
        error: null,
      },
      { insertIfMissing: true },
    );
    const controller = new AbortController();
    sandboxGetMock.mockImplementation(async () => {
      controller.abort();
      throw new Error("status code 404");
    });

    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        signal: controller.signal,
        shouldYield: () => false,
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).rejects.toThrow("status code 404");

    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: { status: "failed", error: "status code 404" },
      ready: null,
    });
  });

  it("marks a build failed when a preparation phase times out", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-phase-timeout-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: randomUUID(),
        status: "building",
        phase: "created",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: "timed-out-builder",
        commandId: null,
        error: null,
      },
      { insertIfMissing: true },
    );
    await getStateAdapter().connect();

    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((delay) =>
        abortSignalTimeout(delay === 10 * 60 * 1000 ? 50 : delay),
      );
    try {
      let commandStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        commandStarted = resolve;
      });
      const deleteBuilder = vi.fn();
      sandboxGetMock.mockImplementation(
        async ({ resume }: { resume: boolean }) => {
          if (!resume) return { delete: deleteBuilder };
          return {
            currentSession: () => ({
              sessionId: "timed-out-session",
              runCommand: vi.fn(
                async ({ signal }: { signal?: AbortSignal }) => {
                  commandStarted();
                  signal?.throwIfAborted();
                  return await new Promise((_, reject) => {
                    signal?.addEventListener(
                      "abort",
                      () => reject(signal.reason),
                      { once: true },
                    );
                  });
                },
              ),
            }),
          };
        },
      );

      const result = resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => false,
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      });
      await started;

      await expect(result).rejects.toThrow(
        "Workspace snapshot build phase timed out after 10 minutes",
      );
      await expect(
        loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
      ).resolves.toMatchObject({
        build: {
          status: "failed",
          error: "Workspace snapshot build phase timed out after 10 minutes",
        },
        ready: null,
      });
      expect(deleteBuilder).toHaveBeenCalledTimes(1);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("keeps the host deadline buffer when the caller can continue", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-deadline-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const requestBudgetMs = Math.max(
      1,
      (getChatConfig().functionMaxDurationSeconds -
        FUNCTION_TIMEOUT_BUFFER_SECONDS) *
        1_000,
    );
    const requestStartedAtMs = Date.now() - requestBudgetMs + 10_000;

    await expect(
      runWithTurnRequestDeadline(
        () =>
          resolveWorkspaceSnapshot({
            workspace,
            runtime: SANDBOX_RUNTIME,
            shouldYield: () => false,
            applyNetworkPolicy: async () => {},
            removeCredentialRoute: false,
          }),
        requestStartedAtMs,
      ),
    ).rejects.toSatisfy(isWorkspaceSnapshotWaitingError);
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("reconnects to the same detached setup after a hard turn abort", async () => {
    const workspace = await createWorkspace({
      name: `snapshot-abort-resume-${randomUUID()}`,
      setupScript: "printf ready",
      repos: [],
    });
    const value = profile.create(SANDBOX_RUNTIME, workspace);
    if (!value) throw new Error("Workspace snapshot profile is missing");

    const builderName = "setup-poll-owner";
    const commandId = "setup-command";
    await setWorkspaceSnapshotBuild(
      workspace.id,
      {
        id: randomUUID(),
        status: "building",
        phase: "repositories_prepared",
        profileHash: value.hash,
        startedAt: new Date(),
        sandboxName: builderName,
        commandId,
        error: null,
      },
      { insertIfMissing: true },
    );

    let waitStarted: (() => void) | undefined;
    const firstWaitStarted = new Promise<void>((resolve) => {
      waitStarted = resolve;
    });
    const wait = vi
      .fn()
      .mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
        waitStarted?.();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        return { exitCode: 0 };
      })
      .mockResolvedValueOnce({ exitCode: 0 });
    const getCommand = vi.fn(async () => ({ wait }));
    const snapshot = vi.fn(async () => ({ snapshotId: "snapshot-after-resume" }));
    const deleteBuilder = vi.fn();
    sandboxGetMock.mockImplementation(async ({ name }: { name: string }) => {
      expect(name).toBe(builderName);
      return {
        getCommand,
        snapshot,
        delete: deleteBuilder,
      };
    });

    const controller = new AbortController();
    const pending = resolveWorkspaceSnapshot({
      workspace,
      runtime: SANDBOX_RUNTIME,
      signal: controller.signal,
      shouldYield: () => false,
      applyNetworkPolicy: async () => {},
      removeCredentialRoute: false,
    });
    await firstWaitStarted;
    controller.abort(
      new DOMException("This operation was aborted", "AbortError"),
    );

    await expect(pending).rejects.toSatisfy(isWorkspaceSnapshotWaitingError);
    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: {
        status: "building",
        sandboxName: builderName,
        commandId,
      },
      ready: null,
    });
    expect(sandboxGetMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: builderName, resume: true }),
    );
    expect(getCommand).toHaveBeenLastCalledWith(
      commandId,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(snapshot).not.toHaveBeenCalled();
    expect(deleteBuilder).not.toHaveBeenCalled();

    // Next host slice reconnects to the same builder + command and finishes.
    await expect(
      resolveWorkspaceSnapshot({
        workspace,
        runtime: SANDBOX_RUNTIME,
        shouldYield: () => false,
        applyNetworkPolicy: async () => {},
        removeCredentialRoute: false,
      }),
    ).resolves.toMatchObject({ snapshotId: "snapshot-after-resume" });

    expect(wait).toHaveBeenCalledTimes(2);
    expect(getCommand).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
    await expect(
      loadSnapshotsForProfile(getDb(), workspace.id, value.hash),
    ).resolves.toMatchObject({
      build: null,
      ready: { id: "snapshot-after-resume" },
    });
  });

  it("attempts every builder cleanup after a provider failure", async () => {
    const attempted: string[] = [];
    sandboxGetMock.mockImplementation(async ({ name }: { name: string }) => ({
      delete: async () => {
        attempted.push(name);
        if (name === "builder-one") throw new Error("provider unavailable");
      },
    }));

    await expect(
      deleteWorkspaceSnapshotBuilders([
        "builder-one",
        "builder-two",
        "builder-three",
      ]),
    ).rejects.toThrow("provider unavailable");
    expect(attempted).toEqual(["builder-one", "builder-two", "builder-three"]);
  });
});
