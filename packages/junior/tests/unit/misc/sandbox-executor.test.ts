import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKSPACE_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { SandboxInstance } from "@/chat/sandbox/workspace";

const { sandboxGetMock, sandboxCreateMock } = vi.hoisted(() => ({
  sandboxGetMock: vi.fn(),
  sandboxCreateMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: sandboxGetMock,
    create: sandboxCreateMock,
  },
}));

vi.mock("bash-tool", () => ({
  createBashTool: vi.fn(),
}));

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
  };
});

vi.mock("@/chat/plugins/registry", () => ({
  getPluginProviders: () => [
    {
      manifest: {
        name: "sentry",
        description: "Sentry",
        capabilities: ["sentry.api"],
        configKeys: [],
        commandEnv: {
          SENTRY_READ_ONLY: "1",
        },
        credentials: {
          type: "oauth-bearer",
          domains: ["sentry.io"],
          authTokenEnv: "SENTRY_AUTH_TOKEN",
          authTokenPlaceholder: "host_managed_credential",
        },
      },
    },
  ],
}));

const {
  resolveRuntimeDependencySnapshotMock,
  isSnapshotMissingErrorMock,
  getRuntimeDependencyProfileHashMock,
} = vi.hoisted(() => ({
  resolveRuntimeDependencySnapshotMock: vi.fn<
    (...args: any[]) => Promise<{
      snapshotId?: string;
      profileHash?: string;
      dependencyCount: number;
      cacheHit: boolean;
      resolveOutcome: string;
      rebuildReason?: string;
    }>
  >(async () => ({
    dependencyCount: 0,
    cacheHit: false,
    resolveOutcome: "no_profile",
  })),
  isSnapshotMissingErrorMock: vi.fn<(error: unknown) => boolean>(() => false),
  getRuntimeDependencyProfileHashMock: vi.fn<
    (runtime: string) => string | undefined
  >(() => undefined),
}));

vi.mock("@/chat/sandbox/runtime-dependency-snapshots", () => ({
  resolveRuntimeDependencySnapshot: resolveRuntimeDependencySnapshotMock,
  isSnapshotMissingError: isSnapshotMissingErrorMock,
  getRuntimeDependencyProfileHash: getRuntimeDependencyProfileHashMock,
}));

import { createSandboxExecutor } from "@/chat/sandbox/sandbox";
import {
  parseSandboxEgressRequesterToken,
  SANDBOX_EGRESS_PROXY_PATH,
} from "@/chat/sandbox/egress-session";
import { createSandboxSessionManager } from "@/chat/sandbox/session";
import { disconnectStateAdapter } from "@/chat/state/adapter";
import { createBashTool } from "bash-tool";

interface MockSandbox {
  name: string;
  currentSession: ReturnType<typeof vi.fn>;
  fs: {
    readFile: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
    readdir: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
  };
  mkDir: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  readFileToBuffer: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  extendTimeout: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
}

function makeSandbox(
  name: string,
  options: {
    mkDirError?: unknown;
    writeFilesError?: unknown;
  } = {},
): MockSandbox {
  return {
    name,
    currentSession: vi.fn(() => ({ sessionId: `${name}_session` })),
    fs: {
      readFile: vi.fn(async () => ""),
      writeFile: vi.fn(async () => {}),
      readdir: vi.fn(async () => []),
      stat: vi.fn(async () => ({ isDirectory: () => false })),
    },
    mkDir: vi.fn(async () => {
      if (options.mkDirError) {
        throw options.mkDirError;
      }
    }),
    writeFiles: vi.fn(async () => {
      if (options.writeFilesError) {
        throw options.writeFilesError;
      }
    }),
    readFileToBuffer: vi.fn(async () => Buffer.from("")),
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => "",
    })),
    stop: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ snapshotId: "snap_test" })),
    update: vi.fn(async () => {}),
  };
}

function sentryForwardURLFromPolicy(policy: unknown): string | undefined {
  const allow = (
    policy as { allow?: Record<string, Array<{ forwardURL?: string }>> }
  ).allow;
  return allow?.["sentry.io"]?.[0]?.forwardURL;
}

function requesterTokenFromForwardURL(
  forwardURL: string | undefined,
): string | undefined {
  if (!forwardURL) {
    return undefined;
  }
  const pathname = new URL(forwardURL).pathname;
  const prefix = `${SANDBOX_EGRESS_PROXY_PATH}/`;
  return pathname.startsWith(prefix)
    ? pathname.slice(prefix.length)
    : undefined;
}

function createApiError(
  status: number,
  statusText: string,
  code: string,
  message: string,
): Error {
  return Object.assign(new Error(`Status code ${status} is not ok`), {
    response: {
      status,
      statusText,
      url: "https://vercel.com/api/v1/sandboxes/sbx_test/fs/mkdir",
      headers: {
        get: (_name: string) => null,
      },
    },
    json: {
      error: {
        code,
        message,
      },
    },
    sandboxId: "sbx_test",
  });
}

async function expectWorkspaceToDelegate(
  workspace: SandboxInstance,
  sandbox: MockSandbox,
): Promise<void> {
  expect(workspace.sandboxId).toBe(sandbox.name);
  expect(workspace.sandboxEgressId).toBe(`${sandbox.name}_session`);
  const fileBuffer = Buffer.from("workspace file");
  const commandResult = {
    exitCode: 0,
    stdout: async () => "stdout",
    stderr: async () => "stderr",
  };

  sandbox.readFileToBuffer.mockResolvedValueOnce(fileBuffer);
  await expect(
    workspace.readFileToBuffer({ path: "/tmp/workspace.txt" }),
  ).resolves.toBe(fileBuffer);
  expect(sandbox.readFileToBuffer).toHaveBeenCalledWith({
    path: "/tmp/workspace.txt",
  });

  sandbox.runCommand.mockResolvedValueOnce(commandResult);
  await expect(
    workspace.runCommand({ cmd: "pwd", args: ["-P"], cwd: "/tmp" }),
  ).resolves.toBe(commandResult);
  expect(sandbox.runCommand).toHaveBeenCalledWith({
    cmd: "pwd",
    args: ["-P"],
    cwd: "/tmp",
  });
}

describe("createSandboxExecutor", () => {
  beforeEach(() => {
    sandboxGetMock.mockReset();
    sandboxCreateMock.mockReset();
    vi.mocked(createBashTool).mockReset();
    resolveRuntimeDependencySnapshotMock.mockReset();
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      dependencyCount: 0,
      cacheHit: false,
      resolveOutcome: "no_profile",
    });
    isSnapshotMissingErrorMock.mockReset();
    isSnapshotMissingErrorMock.mockReturnValue(false);
    getRuntimeDependencyProfileHashMock.mockReset();
    getRuntimeDependencyProfileHashMock.mockReturnValue(undefined);
    delete process.env.VERCEL_TOKEN;
    delete process.env.VERCEL_TEAM_ID;
    delete process.env.VERCEL_PROJECT_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
    delete process.env.VERCEL_SANDBOX_KEEPALIVE_MS;
    delete process.env.JUNIOR_EVAL_ENABLE_FAULTS;
    delete process.env.JUNIOR_EVAL_FAULT_SANDBOX_BASH_STREAM_INTERRUPTS;
    delete process.env.EVAL_ENABLE_TEST_CREDENTIALS;
    process.env.JUNIOR_BASE_URL = "https://junior.example.com";
    process.env.JUNIOR_SANDBOX_EGRESS_SECRET = "test-egress-secret";
  });

  afterEach(async () => {
    await disconnectStateAdapter();
    delete process.env.JUNIOR_BASE_URL;
    delete process.env.JUNIOR_SANDBOX_EGRESS_SECRET;
  });

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

  it("runs bash commands through a noninteractive shell", async () => {
    const sandbox = makeSandbox("sbx_bash");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({ sandboxId: "sbx_bash" });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo ok",
      },
    });

    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation).toMatchObject({
      cmd: "bash",
      cwd: "/vercel/sandbox",
    });
    expect(invocation.args?.[0]).toBe("-c");
    expect(invocation.args?.[1]).toContain(
      'export PATH="/vercel/sandbox/.junior/bin:$PATH"',
    );
    expect(invocation.args?.[1]).toContain("export CI='1'");
    expect(invocation.args?.[1]).toContain("export TERM='dumb'");
    expect(invocation.args?.[1]).toContain("export GH_PROMPT_DISABLED='1'");
    expect(invocation.args?.[1]).toContain("export GIT_TERMINAL_PROMPT='0'");
    expect(invocation.args?.[1]).toContain("exec </dev/null");
    expect(invocation.args?.[1]).toContain("echo ok");
  });

  it("resolves sandbox command environment for each bash command", async () => {
    const sandbox = makeSandbox("sbx_dynamic_env");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);
    const commandEnv = vi
      .fn<() => Promise<Record<string, string>>>()
      .mockResolvedValueOnce({
        GIT_AUTHOR_NAME: "first-bot",
      })
      .mockResolvedValueOnce({
        GIT_AUTHOR_NAME: "second-bot",
      });

    const manager = createSandboxSessionManager({
      sandboxId: "sbx_dynamic_env",
      commandEnv,
    });
    const bash = (await manager.ensureToolExecutors()).bash;

    await bash({ command: "git commit --allow-empty -m first" });
    await bash({ command: "git commit --allow-empty -m second" });

    expect(commandEnv).toHaveBeenCalledTimes(2);
    expect(sandbox.runCommand.mock.calls[0]?.[0].args?.[1]).toContain(
      "export GIT_AUTHOR_NAME='first-bot'",
    );
    expect(sandbox.runCommand.mock.calls[1]?.[0].args?.[1]).toContain(
      "export GIT_AUTHOR_NAME='second-bot'",
    );
  });

  it("configures lazy requester auth for sandbox egress", async () => {
    const sandbox = makeSandbox("sbx_authorize_credentials");
    sandbox.runCommand.mockImplementationOnce(async () => {
      const activePolicy = sandbox.update.mock.calls.at(-1)?.[0].networkPolicy;
      const activeRequesterToken = requesterTokenFromForwardURL(
        sentryForwardURLFromPolicy(activePolicy),
      );

      expect(
        parseSandboxEgressRequesterToken(activeRequesterToken),
      ).toMatchObject({
        requesterId: "U123",
        egressId: "sbx_authorize_credentials_session",
      });
      return {
        exitCode: 0,
        stdout: async () => "",
        stderr: async () => "",
      };
    });
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_authorize_credentials",
      credentialEgress: {
        requesterId: "U123",
      },
    });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "sentry-cli issues list",
      },
    });

    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(
      requesterTokenFromForwardURL(
        sentryForwardURLFromPolicy(
          sandbox.update.mock.calls[0]?.[0].networkPolicy,
        ),
      ),
    ).toBeTruthy();
    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation.args?.[1]).toContain(
      "export SENTRY_AUTH_TOKEN='host_managed_credential'",
    );
    expect(invocation.args?.[1]).toContain("sentry-cli issues list");
  });

  it("makes registered provider credentials available to sandbox commands", async () => {
    const sandbox = makeSandbox("sbx_registered_credentials");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_registered_credentials",
      credentialEgress: {
        requesterId: "U123",
      },
    });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo local-only",
      },
    });

    expect(sandbox.update).toHaveBeenCalledTimes(1);
    expect(
      requesterTokenFromForwardURL(
        sentryForwardURLFromPolicy(
          sandbox.update.mock.calls[0]?.[0].networkPolicy,
        ),
      ),
    ).toBeTruthy();
    const invocation = sandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation.args?.[1]).toContain(
      "export SENTRY_AUTH_TOKEN='host_managed_credential'",
    );
    expect(invocation.args?.[1]).toContain("echo local-only");
  });

  it("returns a failed bash result when the command stream ends without a status", async () => {
    const streamError = Object.assign(
      new Error("Stream ended before command finished"),
      { name: "StreamError" },
    );
    const sandbox = makeSandbox("sbx_stream_interrupted");
    sandbox.runCommand.mockRejectedValueOnce(streamError);
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_stream_interrupted",
    });
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "bash",
      input: {
        command: "pnpm test",
      },
    });

    expect(response.result).toMatchObject({
      ok: false,
      exit_code: 125,
      stderr:
        "Command stream ended before the command finished. The command may still have produced side effects; inspect the workspace or rerun only if it is safe.",
    });
  });

  it("supports eval-only bash stream interruption fault injection", async () => {
    process.env.JUNIOR_EVAL_ENABLE_FAULTS = "1";
    process.env.JUNIOR_EVAL_FAULT_SANDBOX_BASH_STREAM_INTERRUPTS = "1";
    const sandbox = makeSandbox("sbx_fault_injection");
    sandbox.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: async () => "ok\n",
      stderr: async () => "",
    });
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_fault_injection",
    });
    executor.configureSkills([]);

    const interrupted = await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    const recovered = await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(interrupted.result).toMatchObject({
      ok: false,
      exit_code: 125,
    });
    expect(recovered.result).toMatchObject({
      ok: true,
      stdout: "ok\n",
    });
    expect(sandbox.runCommand).toHaveBeenCalledTimes(1);
  });

  it("routes matching bash commands through custom command handler", async () => {
    const sandbox = makeSandbox("sbx_custom");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);
    const runBashCustomCommand = vi.fn(async (command: string) =>
      command === "jr-rpc config get github.repo"
        ? {
            handled: true,
            result: {
              ok: true,
              command,
              cwd: "/",
              exit_code: 0,
              signal: null,
              timed_out: false,
              stdout: "credential_enabled\n",
              stderr: "",
              stdout_truncated: false,
              stderr_truncated: false,
            },
          }
        : { handled: false },
    );

    const executor = createSandboxExecutor({
      sandboxId: "sbx_custom",
      runBashCustomCommand,
    });
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "bash",
      input: {
        command: "jr-rpc config get github.repo",
      },
    });

    expect(runBashCustomCommand).toHaveBeenCalledWith(
      "jr-rpc config get github.repo",
    );
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(response.result).toMatchObject({
      ok: true,
      exit_code: 0,
    });
  });

  it("syncs sandbox files once when the first tool call also initializes tool executors", async () => {
    const sandbox = makeSandbox("sbx_single_sync");
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo ok",
      },
    });

    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createBashTool)).toHaveBeenCalledTimes(1);
  });

  it("extends sandbox keepalive for each tool execution", async () => {
    process.env.VERCEL_SANDBOX_KEEPALIVE_MS = "5000";
    const sandbox = makeSandbox("sbx_keepalive");
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(sandbox.extendTimeout).toHaveBeenCalledTimes(2);
    expect(sandbox.extendTimeout).toHaveBeenNthCalledWith(1, 5000);
    expect(sandbox.extendTimeout).toHaveBeenNthCalledWith(2, 5000);
  });

  it("does not re-sync skills when reusing a cached sandbox", async () => {
    const sandbox = makeSandbox("sbx_cached_once");
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(sandbox.writeFiles).toHaveBeenCalledTimes(1);
  });

  it("recreates cached sandboxes before reusing cached tool executors", async () => {
    const stoppedSandboxError = createApiError(
      410,
      "Gone",
      "sandbox_stopped",
      "Sandbox has stopped execution and is no longer available",
    );
    const firstSandbox = makeSandbox("sbx_cached_first");
    let stopCachedSandbox = false;
    firstSandbox.mkDir.mockImplementation(async (directory: string) => {
      if (stopCachedSandbox && directory === SANDBOX_WORKSPACE_ROOT) {
        throw stoppedSandboxError;
      }
    });
    firstSandbox.runCommand
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: async () => "first\n",
        stderr: async () => "",
      })
      .mockRejectedValueOnce(new Error("expired sandbox should not be reused"));

    const secondSandbox = makeSandbox("sbx_cached_second");
    secondSandbox.runCommand.mockResolvedValueOnce({
      exitCode: 0,
      stdout: async () => "second\n",
      stderr: async () => "",
    });

    sandboxCreateMock
      .mockResolvedValueOnce(firstSandbox)
      .mockResolvedValueOnce(secondSandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo first",
      },
    });
    stopCachedSandbox = true;

    const response = await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(response.result).toMatchObject({
      ok: true,
      stdout: "second\n",
      exit_code: 0,
    });
    expect(firstSandbox.writeFiles).toHaveBeenCalledTimes(1);
    expect(firstSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(secondSandbox.runCommand).toHaveBeenCalledTimes(1);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
  });

  it("reads virtual skill files without booting a sandbox before sandbox state exists", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-read-"),
    );
    await fs.mkdir(path.join(skillRoot, "references"));
    await fs.writeFile(
      path.join(skillRoot, "references", "note.md"),
      "Reference note",
      "utf8",
    );

    const executor = createSandboxExecutor();
    executor.configureSkills([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: skillRoot,
      },
    ]);

    const response = await executor.execute({
      toolName: "readFile",
      input: {
        path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      },
    });

    expect(response.result).toEqual({
      content: "Reference note",
      end_line: 1,
      path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      start_line: 1,
      success: true,
      total_lines: 1,
      truncated: false,
    });
    expect(sandboxGetMock).not.toHaveBeenCalled();
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("falls through to sandbox when a virtual skill file is missing on the host", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-read-missing-"),
    );
    const sandbox = makeSandbox("sbx_missing_virtual_skill_file");
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "from sandbox" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: skillRoot,
      },
    ]);

    const response = await executor.execute({
      toolName: "readFile",
      input: {
        path: `${sandboxSkillDir("demo-skill")}/references/missing.md`,
      },
    });

    expect(response.result).toEqual({
      content: "from sandbox",
      end_line: 1,
      path: `${sandboxSkillDir("demo-skill")}/references/missing.md`,
      start_line: 1,
      success: true,
      total_lines: 1,
      truncated: false,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
  });

  it("returns a readFile tool result when the sandbox path is missing", async () => {
    const sandbox = makeSandbox("sbx_missing_read_file");
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: {
          execute: vi.fn(async () => {
            throw new Error("File not found: /vercel/sandbox/missing.ts");
          }),
        },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "readFile",
      input: {
        path: "missing.ts",
      },
    });

    expect(response.result).toEqual({
      content: "",
      error: "not_found",
      path: "missing.ts",
      success: false,
    });
  });

  it("throws ToolInputError when editFile targets a missing path", async () => {
    const sandbox = makeSandbox("sbx_missing_edit_file");
    sandbox.fs.readFile.mockRejectedValue(
      Object.assign(new Error("ENOENT: no such file or directory"), {
        code: "ENOENT",
      }),
    );
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await expect(
      executor.execute({
        toolName: "editFile",
        input: {
          path: "missing.ts",
          edits: [{ oldText: "a", newText: "b" }],
        },
      }),
    ).rejects.toThrow("File not found: missing.ts");
  });

  it("keeps sandbox API failures as readFile errors", async () => {
    const sandbox = makeSandbox("sbx_read_file_api_error");
    sandboxCreateMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: {
          execute: vi.fn(async () => {
            throw createApiError(
              410,
              "Gone",
              "sandbox_stopped",
              "Sandbox has stopped execution and is no longer available",
            );
          }),
        },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await expect(
      executor.execute({
        toolName: "readFile",
        input: {
          path: "missing.ts",
        },
      }),
    ).rejects.toThrow("Status code 410 is not ok");
  });

  it("reads virtual skill files from sandbox when a sandbox id hint exists", async () => {
    const skillRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-skill-read-hinted-"),
    );
    await fs.mkdir(path.join(skillRoot, "references"));
    await fs.writeFile(
      path.join(skillRoot, "references", "note.md"),
      "Host note",
      "utf8",
    );
    const sandbox = makeSandbox("sbx_existing");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "Sandbox note" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({ sandboxId: "sbx_existing" });
    executor.configureSkills([
      {
        name: "demo-skill",
        description: "Demo skill",
        skillPath: skillRoot,
      },
    ]);

    const response = await executor.execute({
      toolName: "readFile",
      input: {
        path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      },
    });

    expect(response.result).toEqual({
      content: "Sandbox note",
      end_line: 1,
      path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      start_line: 1,
      success: true,
      total_lines: 1,
      truncated: false,
    });
    expect(sandboxGetMock).toHaveBeenCalledWith({
      name: "sbx_existing",
      resume: true,
    });
  });

  it("installs the eval gh shim when test credentials are enabled", async () => {
    process.env.EVAL_ENABLE_TEST_CREDENTIALS = "1";
    const sandbox = makeSandbox("sbx_eval_gh");
    sandboxCreateMock.mockResolvedValue(sandbox);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await executor.createSandbox();

    const syncedFiles = sandbox.writeFiles.mock.calls[0]?.[0] as Array<{
      path: string;
      content: Buffer;
    }>;
    expect(syncedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/vercel/sandbox/.junior/bin/gh",
        }),
      ]),
    );
    const chmodCall = sandbox.runCommand.mock.calls.find(
      (call) =>
        call[0]?.cmd === "bash" &&
        typeof call[0]?.args?.[1] === "string" &&
        call[0].args[1].includes(
          "'chmod' '0755' '/vercel/sandbox/.junior/bin/gh'",
        ),
    );
    expect(chmodCall).toBeDefined();
  });

  it("creates fresh sandboxes from dependency snapshots when available", async () => {
    const snapshotSandbox = makeSandbox("sbx_snapshot");
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      snapshotId: "snap_123",
      profileHash: "hash_123",
      dependencyCount: 2,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    sandboxCreateMock.mockResolvedValue(snapshotSandbox);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, snapshotSandbox);
    expect(sandboxCreateMock).toHaveBeenCalledWith({
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_123",
      },
    });
  });

  it("rebuilds snapshot when cached snapshot is missing", async () => {
    const rebuiltSandbox = makeSandbox("sbx_rebuilt");
    resolveRuntimeDependencySnapshotMock
      .mockResolvedValueOnce({
        snapshotId: "snap_missing",
        profileHash: "hash_1",
        dependencyCount: 2,
        cacheHit: true,
        resolveOutcome: "cache_hit",
      })
      .mockResolvedValueOnce({
        snapshotId: "snap_rebuilt",
        profileHash: "hash_1",
        dependencyCount: 2,
        cacheHit: false,
        resolveOutcome: "forced_rebuild",
        rebuildReason: "snapshot_missing",
      });
    const missingError = new Error("snapshot not found");
    sandboxCreateMock
      .mockRejectedValueOnce(missingError)
      .mockResolvedValueOnce(rebuiltSandbox);
    isSnapshotMissingErrorMock.mockImplementation(
      (error: unknown) => error === missingError,
    );

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, rebuiltSandbox);
    expect(resolveRuntimeDependencySnapshotMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        runtime: "node22",
        timeoutMs: 1000 * 60 * 30,
        forceRebuild: true,
        staleSnapshotId: "snap_missing",
      }),
    );
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(2, {
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_rebuilt",
      },
    });
  });

  it("retries snapshot boot when Vercel reports snapshotting in progress", async () => {
    const snapshotSandbox = makeSandbox("sbx_snapshot_ready");
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      snapshotId: "snap_retry",
      profileHash: "hash_retry",
      dependencyCount: 2,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const snapshottingError = createApiError(
      422,
      "Unprocessable Entity",
      "sandbox_snapshotting",
      "Sandbox is creating a snapshot and will be stopped shortly.",
    );
    sandboxCreateMock
      .mockRejectedValueOnce(snapshottingError)
      .mockResolvedValueOnce(snapshotSandbox);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    await expectWorkspaceToDelegate(sandbox, snapshotSandbox);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(1, {
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_retry",
      },
    });
    expect(sandboxCreateMock).toHaveBeenNthCalledWith(2, {
      timeout: 1000 * 60 * 30,
      source: {
        type: "snapshot",
        snapshotId: "snap_retry",
      },
    });
  });

  it("uses a fresh sandbox name when retrying snapshot boot with network policy", async () => {
    const snapshotSandbox = makeSandbox("sbx_snapshot_policy_ready");
    resolveRuntimeDependencySnapshotMock.mockResolvedValue({
      snapshotId: "snap_policy_retry",
      profileHash: "hash_policy_retry",
      dependencyCount: 2,
      cacheHit: true,
      resolveOutcome: "cache_hit",
    });
    const snapshottingError = createApiError(
      422,
      "Unprocessable Entity",
      "sandbox_snapshotting",
      "Sandbox is creating a snapshot and will be stopped shortly.",
    );
    sandboxCreateMock
      .mockRejectedValueOnce(snapshottingError)
      .mockResolvedValueOnce(snapshotSandbox);
    const createNetworkPolicy = vi.fn((sandboxId: string) => ({
      allow: {
        "*": [],
        "api.example.com": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${sandboxId}`,
          },
        ],
      },
    }));

    const manager = createSandboxSessionManager({ createNetworkPolicy });
    manager.configureSkills([]);

    await manager.createSandbox();

    const firstCreate = sandboxCreateMock.mock.calls[0]?.[0] as {
      name?: string;
      networkPolicy?: unknown;
    };
    const secondCreate = sandboxCreateMock.mock.calls[1]?.[0] as {
      name?: string;
      networkPolicy?: unknown;
    };
    expect(firstCreate.name).toMatch(/^junior-/);
    expect(secondCreate.name).toMatch(/^junior-/);
    expect(secondCreate.name).not.toBe(firstCreate.name);
    expect(createNetworkPolicy).toHaveBeenNthCalledWith(1, firstCreate.name);
    expect(createNetworkPolicy).toHaveBeenNthCalledWith(2, secondCreate.name);
    expect(createNetworkPolicy).toHaveBeenNthCalledWith(
      3,
      "sbx_snapshot_policy_ready_session",
    );
    expect(secondCreate.networkPolicy).toEqual({
      allow: {
        "*": [],
        "api.example.com": [
          {
            forwardURL: `https://junior.example.com/api/internal/sandbox-egress/${secondCreate.name}`,
          },
        ],
      },
    });
    expect(snapshotSandbox.update).toHaveBeenCalledWith({
      networkPolicy: {
        allow: {
          "*": [],
          "api.example.com": [
            {
              forwardURL:
                "https://junior.example.com/api/internal/sandbox-egress/sbx_snapshot_policy_ready_session",
            },
          ],
        },
      },
    });
  });

  it("wraps snapshot resolution failures as sandbox setup errors", async () => {
    resolveRuntimeDependencySnapshotMock.mockRejectedValueOnce(
      new Error("lock timeout"),
    );

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toThrow(
      "sandbox setup failed",
    );
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });
});
