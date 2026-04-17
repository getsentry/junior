import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAssistantStatus } from "@/chat/slack/assistant-thread/status";
import { SANDBOX_WORKSPACE_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import type { SandboxWorkspace } from "@/chat/sandbox/workspace";

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
import { createBashTool } from "bash-tool";

interface MockSandbox {
  sandboxId: string;
  mkDir: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  readFileToBuffer: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  updateNetworkPolicy: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  extendTimeout: ReturnType<typeof vi.fn>;
  networkPolicy?: unknown;
}

function makeSandbox(
  sandboxId: string,
  options: {
    mkDirError?: unknown;
    writeFilesError?: unknown;
  } = {},
): MockSandbox {
  return {
    sandboxId,
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
    updateNetworkPolicy: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    networkPolicy: "allow-all",
  };
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
  workspace: SandboxWorkspace,
  sandbox: MockSandbox,
): Promise<void> {
  expect(workspace.sandboxId).toBe(sandbox.sandboxId);
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
    delete process.env.EVAL_ENABLE_TEST_CREDENTIALS;
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
    expect(sandboxGetMock).toHaveBeenCalledWith({ sandboxId: "sbx_stopped" });
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
      sandboxId: "sbx_stopped",
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

  it("applies and restores header transforms for bash commands", async () => {
    const sandbox = makeSandbox("sbx_headers");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({ sandboxId: "sbx_headers" });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo ok",
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: {
              Authorization: "Bearer token-1",
            },
          },
        ],
      },
    });

    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(1, {
      allow: {
        "*": [],
        "api.github.com": [
          {
            transform: [
              {
                headers: {
                  Authorization: "Bearer token-1",
                },
              },
            ],
          },
        ],
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
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(2, "allow-all");
  });

  it("merges header transforms into existing network policy allow rules", async () => {
    const sandbox = makeSandbox("sbx_policy_merge");
    sandbox.networkPolicy = {
      allow: {
        "example.com": [{ transform: [{ headers: { "X-Existing": "1" } }] }],
      },
    };
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({ sandboxId: "sbx_policy_merge" });
    executor.configureSkills([]);

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo ok",
        headerTransforms: [
          {
            domain: "api.github.com",
            headers: {
              Authorization: "Bearer token-1",
            },
          },
        ],
      },
    });

    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(1, {
      allow: {
        "example.com": [{ transform: [{ headers: { "X-Existing": "1" } }] }],
        "api.github.com": [
          {
            transform: [
              {
                headers: {
                  Authorization: "Bearer token-1",
                },
              },
            ],
          },
        ],
      },
    });
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(
      2,
      sandbox.networkPolicy,
    );
  });

  it("preserves command errors when network policy restore fails", async () => {
    const sandbox = makeSandbox("sbx_restore_failure");
    sandbox.runCommand.mockRejectedValueOnce(new Error("command failed"));
    sandbox.updateNetworkPolicy
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error("restore failed");
      });
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor({
      sandboxId: "sbx_restore_failure",
    });
    executor.configureSkills([]);

    await expect(
      executor.execute({
        toolName: "bash",
        input: {
          command: "echo ok",
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: "Bearer token-1",
              },
            },
          ],
        },
      }),
    ).rejects.toThrow("command failed");
    expect(sandbox.updateNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("discards the sandbox when network policy restore fails after a successful command", async () => {
    const firstSandbox = makeSandbox("sbx_restore_failure_first");
    firstSandbox.updateNetworkPolicy
      .mockImplementationOnce(async () => {})
      .mockImplementationOnce(async () => {
        throw new Error("restore failed");
      });
    const secondSandbox = makeSandbox("sbx_restore_failure_second");
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

    await expect(
      executor.execute({
        toolName: "bash",
        input: {
          command: "echo ok",
          headerTransforms: [
            {
              domain: "api.github.com",
              headers: {
                Authorization: "Bearer token-1",
              },
            },
          ],
        },
      }),
    ).rejects.toThrow("restore failed");

    await executor.execute({
      toolName: "bash",
      input: {
        command: "echo second",
      },
    });

    expect(firstSandbox.stop).toHaveBeenCalledTimes(1);
    expect(sandboxCreateMock).toHaveBeenCalledTimes(2);
    const invocation = secondSandbox.runCommand.mock.calls[0]?.[0];
    expect(invocation).toMatchObject({
      cmd: "bash",
      cwd: "/vercel/sandbox",
    });
    expect(invocation.args?.[1]).toContain("exec </dev/null");
    expect(invocation.args?.[1]).toContain("echo second");
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
      command === "jr-rpc issue-credential github.issues.write"
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
        command: "jr-rpc issue-credential github.issues.write",
      },
    });

    expect(runBashCustomCommand).toHaveBeenCalledWith(
      "jr-rpc issue-credential github.issues.write",
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
      path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      success: true,
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
      path: `${sandboxSkillDir("demo-skill")}/references/missing.md`,
      success: true,
    });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
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
      path: `${sandboxSkillDir("demo-skill")}/references/note.md`,
      success: true,
    });
    expect(sandboxGetMock).toHaveBeenCalledWith({ sandboxId: "sbx_existing" });
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

  it("emits sandbox phase status updates before booting", async () => {
    const sandbox = makeSandbox("sbx_status");
    sandboxCreateMock.mockResolvedValue(sandbox);
    const statuses: ReturnType<typeof makeAssistantStatus>[] = [];
    resolveRuntimeDependencySnapshotMock.mockImplementationOnce(
      async (params: { onProgress?: (phase: string) => Promise<void> }) => {
        await params.onProgress?.("resolve_start");
        await params.onProgress?.("waiting_for_lock");
        await params.onProgress?.("building_snapshot");
        await params.onProgress?.("cache_hit");
        await params.onProgress?.("build_complete");
        return {
          snapshotId: "snap_status",
          profileHash: "hash_status",
          dependencyCount: 2,
          cacheHit: false,
          resolveOutcome: "rebuilt",
        };
      },
    );

    const executor = createSandboxExecutor({
      onStatus: async (status) => {
        statuses.push(status);
      },
    });
    executor.configureSkills([]);

    await executor.createSandbox();

    expect(statuses).toEqual([
      makeAssistantStatus("loading", "sandbox runtime"),
      makeAssistantStatus("loading", "sandbox snapshot cache"),
      makeAssistantStatus("loading", "sandbox snapshot build"),
      makeAssistantStatus("creating", "sandbox snapshot"),
    ]);
  });
});
