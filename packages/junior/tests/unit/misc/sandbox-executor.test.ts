import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKSPACE_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import {
  createBashTool,
  createApiError,
  createSandboxExecutor,
  createSandboxSessionManager,
  createStreamInterruptedError,
  expectWorkspaceToDelegate,
  getRuntimeDependencyProfileHashMock,
  makeSandbox,
  sandboxCreateMock,
  sandboxGetMock,
  setupSandboxExecutorTest,
  cleanupSandboxExecutorTest,
} from "../../fixtures/sandbox-executor";

describe("createSandboxExecutor", () => {
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
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

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

  it("returns structured file-tool results when sandbox command streams end", async () => {
    const sandbox = makeSandbox("sbx_find_files_interrupted");
    sandbox.fs.stat.mockRejectedValueOnce(createStreamInterruptedError());
    sandboxCreateMock.mockResolvedValueOnce(sandbox);
    vi.mocked(createBashTool).mockResolvedValueOnce({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "findFiles",
      input: { pattern: "*.ts" },
    });

    expect(response.result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "Sandbox command stream was interrupted during findFiles",
          ),
        },
      ],
      details: {
        ok: false,
        error: "stream_interrupted",
        tool: "findFiles",
      },
    });
  });

  it("recognizes stream interruptions wrapped by writeFile errors", async () => {
    const sandbox = makeSandbox("sbx_write_file_interrupted");
    const writeFileExecute = vi.fn(async () => {
      throw createStreamInterruptedError();
    });
    sandboxCreateMock.mockResolvedValueOnce(sandbox);
    vi.mocked(createBashTool).mockResolvedValueOnce({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: writeFileExecute },
      },
    } as never);

    const executor = createSandboxExecutor();
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "writeFile",
      input: { path: "file.ts", content: "new content" },
    });

    expect(response.result).toMatchObject({
      details: {
        ok: false,
        error: "stream_interrupted",
        tool: "writeFile",
      },
    });
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
});
