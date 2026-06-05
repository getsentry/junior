import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_WORKSPACE_ROOT, sandboxSkillDir } from "@/chat/sandbox/paths";
import {
  createApiError,
  createBashTool,
  createSandboxExecutor,
  createStreamInterruptedError,
  makeBashToolFacade,
  makeSandbox,
  sandboxCreateMock,
  sandboxGetMock,
  setupSandboxExecutorTest,
  cleanupSandboxExecutorTest,
} from "../../fixtures/sandbox-executor";

describe("sandbox executor tool execution", () => {
  beforeEach(setupSandboxExecutorTest);

  afterEach(cleanupSandboxExecutorTest);

  it("returns structured file-tool results when sandbox command streams end", async () => {
    const sandbox = makeSandbox("sbx_find_files_interrupted");
    sandbox.fs.stat.mockRejectedValueOnce(createStreamInterruptedError());
    sandboxCreateMock.mockResolvedValueOnce(sandbox);

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
    vi.mocked(createBashTool).mockResolvedValueOnce(
      makeBashToolFacade({ writeFile: writeFileExecute }) as never,
    );

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
    vi.mocked(createBashTool).mockResolvedValue(
      makeBashToolFacade({
        readFile: vi.fn(async () => ({ content: "from sandbox" })),
      }) as never,
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
    vi.mocked(createBashTool).mockResolvedValue(
      makeBashToolFacade({
        readFile: vi.fn(async () => {
          throw new Error("File not found: /vercel/sandbox/missing.ts");
        }),
      }) as never,
    );

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
    vi.mocked(createBashTool).mockResolvedValue(
      makeBashToolFacade({
        readFile: vi.fn(async () => {
          throw createApiError(
            410,
            "Gone",
            "sandbox_stopped",
            "Sandbox has stopped execution and is no longer available",
          );
        }),
      }) as never,
    );

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
    vi.mocked(createBashTool).mockResolvedValue(
      makeBashToolFacade({
        readFile: vi.fn(async () => ({ content: "Sandbox note" })),
      }) as never,
    );

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
