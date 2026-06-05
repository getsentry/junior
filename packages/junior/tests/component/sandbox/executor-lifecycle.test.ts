import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createApiError,
  createBashTool,
  createSandboxExecutor,
  createSandboxSessionManager,
  cleanupSandboxExecutorTest,
  expectWorkspaceToDelegate,
  getRuntimeDependencyProfileHashMock,
  makeSandbox,
  sandboxCreateMock,
  sandboxGetMock,
  setupSandboxExecutorTest,
} from "../../fixtures/sandbox-executor";

describe("sandbox executor lifecycle", () => {
  beforeEach(setupSandboxExecutorTest);

  afterEach(cleanupSandboxExecutorTest);

  it("recreates a sandbox when sandboxId hint points to a stopped sandbox", async () => {
    const stoppedSandbox = makeSandbox("sbx_stopped", {
      mkDirError: createApiError(
        410,
        "Gone",
        "sandbox_stopped",
        "Sandbox has stopped execution and is no longer available",
      ),
    });
    const freshSandbox = makeSandbox("sbx_fresh");

    sandboxGetMock.mockResolvedValue(stoppedSandbox);
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_stopped" });
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, freshSandbox);
    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: "sbx_stopped",
      resume: true,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(stoppedSandbox.mkDir).toHaveBeenCalled();
    expect(freshSandbox.mkDir).toHaveBeenCalled();
    expect(executor.getSandboxId()).toBe("sbx_fresh");
  });

  it("reports acquired sandbox metadata immediately after fresh sandbox boot", async () => {
    const freshSandbox = makeSandbox("sbx_fresh");
    const onSandboxAcquired = vi.fn();
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createSandboxExecutor({
      onSandboxAcquired,
    });
    executor.configureSkills([]);

    await executor.createSandbox();
    await executor.createSandbox();

    expect(onSandboxAcquired).toHaveBeenCalledTimes(1);
    expect(onSandboxAcquired).toHaveBeenCalledWith({
      sandboxId: "sbx_fresh",
    });
  });

  it("prepares a cached sandbox only once", async () => {
    const freshSandbox = makeSandbox("sbx_fresh");
    const onSandboxPrepare = vi.fn();
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const manager = createSandboxSessionManager({
      onSandboxPrepare,
    });
    manager.configureSkills([]);

    await manager.createSandbox();
    await manager.createSandbox();

    expect(onSandboxPrepare).toHaveBeenCalledTimes(1);
    expect(onSandboxPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_fresh",
      }),
    );
  });

  it("shares in-flight sandbox setup across parallel executor initialization", async () => {
    const freshSandbox = makeSandbox("sbx_parallel_boot");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    let markPrepareStarted: () => void = () => {};
    let releasePrepare: () => void = () => {};
    const prepareStarted = new Promise<void>((resolve) => {
      markPrepareStarted = resolve;
    });
    const prepareReleased = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const onSandboxPrepare = vi.fn(async () => {
      markPrepareStarted();
      await prepareReleased;
    });
    const manager = createSandboxSessionManager({
      onSandboxPrepare,
    });
    manager.configureSkills([]);

    const first = manager.ensureToolExecutors();
    await prepareStarted;
    const second = manager.ensureToolExecutors();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(onSandboxPrepare).toHaveBeenCalledTimes(1);

    releasePrepare();
    const [firstExecutors, secondExecutors] = await Promise.all([
      first,
      second,
    ]);

    expect(firstExecutors).toBe(secondExecutors);
    expect(vi.mocked(createBashTool)).toHaveBeenCalledTimes(1);
  });

  it("reports acquired sandbox metadata when restoring from a sandbox id hint", async () => {
    const restoredSandbox = makeSandbox("sbx_restored");
    const onSandboxAcquired = vi.fn();
    sandboxGetMock.mockResolvedValue(restoredSandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_restored",
      onSandboxAcquired,
    });
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(onSandboxAcquired).toHaveBeenCalledTimes(1);
    expect(onSandboxAcquired).toHaveBeenCalledWith({
      sandboxId: "sbx_restored",
    });
  });

  it("refreshes network policy when restoring from a sandbox id hint", async () => {
    const restoredSandbox = makeSandbox("sbx_restored");
    const networkPolicy = {
      allow: {
        "*": [],
        "api.example.com": [
          {
            forwardURL: "https://junior.example.com/api/internal/proxy",
          },
        ],
      },
    };
    sandboxGetMock.mockResolvedValue(restoredSandbox);

    const manager = createSandboxSessionManager({
      sandboxId: "sbx_restored",
      createNetworkPolicy: vi.fn(() => networkPolicy),
    });
    manager.configureSkills([]);

    await manager.createSandbox();

    expect(restoredSandbox.update).toHaveBeenCalledWith({ networkPolicy });
  });

  it("keeps restored sandbox policy tracking tied to the applied policy", async () => {
    const restoredSandbox = makeSandbox("sbx_restored_policy");
    const firstPolicy = {
      allow: {
        "*": [],
        "api.first.example": [
          {
            forwardURL: "https://junior.example.com/api/internal/proxy",
          },
        ],
      },
    };
    const secondPolicy = {
      allow: {
        "*": [],
        "api.second.example": [
          {
            forwardURL: "https://junior.example.com/api/internal/proxy",
          },
        ],
      },
    };
    const createNetworkPolicy = vi
      .fn()
      .mockReturnValueOnce(firstPolicy)
      .mockReturnValueOnce(secondPolicy);
    sandboxGetMock.mockResolvedValue(restoredSandbox);

    const manager = createSandboxSessionManager({
      sandboxId: "sbx_restored_policy",
      createNetworkPolicy,
    });
    manager.configureSkills([]);

    await manager.createSandbox();
    await manager.createSandbox();

    expect(restoredSandbox.update).toHaveBeenNthCalledWith(1, {
      networkPolicy: firstPolicy,
    });
    expect(restoredSandbox.update).toHaveBeenNthCalledWith(2, {
      networkPolicy: secondPolicy,
    });
    expect(createNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("refreshes changed network policy when reusing a cached sandbox", async () => {
    const sandbox = makeSandbox("sbx_cached_policy");
    sandboxCreateMock.mockResolvedValue(sandbox);
    let providerDomain = "api.first.example";
    const createNetworkPolicy = vi.fn((sandboxId: string) => ({
      allow: {
        "*": [],
        [providerDomain]: [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${sandboxId}`,
          },
        ],
      },
    }));

    const manager = createSandboxSessionManager({ createNetworkPolicy });
    manager.configureSkills([]);

    await manager.createSandbox();
    await manager.createSandbox();
    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(sandbox.update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.first.example": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_cached_policy_session",
            },
          ],
        },
      },
    });

    sandbox.currentSession.mockReturnValue({
      sessionId: "sbx_cached_policy_resumed_session",
    });
    await manager.createSandbox();

    expect(sandbox.update).toHaveBeenCalledTimes(2);
    expect(sandbox.update).toHaveBeenLastCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.first.example": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_cached_policy_resumed_session",
            },
          ],
        },
      },
    });

    providerDomain = "api.second.example";
    await manager.createSandbox();

    expect(sandbox.update).toHaveBeenCalledTimes(3);
    expect(sandbox.update).toHaveBeenLastCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.second.example": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_cached_policy_resumed_session",
            },
          ],
        },
      },
    });
  });

  it("passes token-based Vercel Sandbox credentials to the sandbox SDK", async () => {
    process.env.VERCEL_TOKEN = "sandbox-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    const stoppedSandbox = makeSandbox("sbx_stopped", {
      mkDirError: createApiError(
        410,
        "Gone",
        "sandbox_stopped",
        "Sandbox has stopped execution and is no longer available",
      ),
    });
    const freshSandbox = makeSandbox("sbx_fresh");

    sandboxGetMock.mockResolvedValue(stoppedSandbox);
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_stopped" });
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: "sbx_stopped",
      resume: true,
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      runtime: "node22",
      token: "sandbox-token",
      teamId: "team_123",
      projectId: "prj_123",
    });
  });

  it("recreates sandbox when dependency profile hash changed", async () => {
    const freshSandbox = makeSandbox("sbx_fresh_after_profile_change");
    getRuntimeDependencyProfileHashMock.mockReturnValue("current-profile");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_old",
      sandboxDependencyProfileHash: "old-profile",
    });
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, freshSandbox);
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a generic sandbox setup failure for non-recoverable sync errors", async () => {
    const forbiddenSandbox = makeSandbox("sbx_forbidden", {
      mkDirError: createApiError(
        403,
        "Forbidden",
        "forbidden",
        "You do not have permission to access this sandbox",
      ),
    });

    sandboxGetMock.mockResolvedValue(forbiddenSandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_forbidden" });
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toThrow(
      "sandbox setup failed",
    );
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("defers to SDK OIDC resolution when VERCEL_OIDC_TOKEN is set without explicit credentials", async () => {
    process.env.VERCEL_OIDC_TOKEN = "oidc-jwt-token";
    process.env.VERCEL_TEAM_ID = "team_123";
    process.env.VERCEL_PROJECT_ID = "prj_123";

    const freshSandbox = makeSandbox("sbx_oidc");
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      runtime: "node22",
    });
  });
});
