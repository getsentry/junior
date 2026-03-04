import { beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxGetMock, sandboxCreateMock } = vi.hoisted(() => ({
  sandboxGetMock: vi.fn(),
  sandboxCreateMock: vi.fn()
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: sandboxGetMock,
    create: sandboxCreateMock
  }
}));

vi.mock("bash-tool", () => ({
  createBashTool: vi.fn()
}));

vi.mock("@/chat/observability", () => ({
  withSpan: async (
    _name: string,
    _op: string,
    _context: unknown,
    callback: () => Promise<unknown>
  ) => callback(),
  setSpanAttributes: vi.fn(),
  setSpanStatus: vi.fn()
}));

import { createSandboxExecutor } from "@/chat/sandbox/sandbox";
import { createBashTool } from "bash-tool";

interface MockSandbox {
  sandboxId: string;
  mkDir: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
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
  } = {}
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
    runCommand: vi.fn(async () => ({
      exitCode: 0,
      stdout: async () => "",
      stderr: async () => ""
    })),
    updateNetworkPolicy: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    networkPolicy: "allow-all"
  };
}

function createApiError(status: number, statusText: string, code: string, message: string): Error {
  return Object.assign(new Error(`Status code ${status} is not ok`), {
    response: {
      status,
      statusText,
      url: "https://vercel.com/api/v1/sandboxes/sbx_test/fs/mkdir",
      headers: {
        get: (_name: string) => null
      }
    },
    json: {
      error: {
        code,
        message
      }
    },
    sandboxId: "sbx_test"
  });
}

describe("createSandboxExecutor", () => {
  beforeEach(() => {
    sandboxGetMock.mockReset();
    sandboxCreateMock.mockReset();
    vi.mocked(createBashTool).mockReset();
  });

  it("recreates a sandbox when sandboxId hint points to a stopped sandbox", async () => {
    const stoppedSandbox = makeSandbox(
      "sbx_stopped",
      {
        mkDirError: createApiError(
          410,
          "Gone",
          "sandbox_stopped",
          "Sandbox has stopped execution and is no longer available"
        )
      }
    );
    const freshSandbox = makeSandbox("sbx_fresh");

    sandboxGetMock.mockResolvedValue(stoppedSandbox);
    sandboxCreateMock.mockResolvedValue(freshSandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_stopped" });
    executor.configureSkills([]);

    const sandbox = await executor.createSandbox();

    expect(sandbox).toBe(freshSandbox);
    expect(sandboxGetMock).toHaveBeenCalledWith({ sandboxId: "sbx_stopped" });
    expect(sandboxCreateMock).toHaveBeenCalledTimes(1);
    expect(stoppedSandbox.mkDir).toHaveBeenCalled();
    expect(freshSandbox.mkDir).toHaveBeenCalled();
    expect(freshSandbox.runCommand).not.toHaveBeenCalled();
    expect(executor.getSandboxId()).toBe("sbx_fresh");
  });

  it("surfaces a generic sandbox setup failure for non-recoverable sync errors", async () => {
    const forbiddenSandbox = makeSandbox(
      "sbx_forbidden",
      {
        mkDirError: createApiError(
          403,
          "Forbidden",
          "forbidden",
          "You do not have permission to access this sandbox"
        )
      }
    );

    sandboxGetMock.mockResolvedValue(forbiddenSandbox);

    const executor = createSandboxExecutor({ sandboxId: "sbx_forbidden" });
    executor.configureSkills([]);

    await expect(executor.createSandbox()).rejects.toThrow("sandbox setup failed");
    expect(sandboxCreateMock).not.toHaveBeenCalled();
  });

  it("applies and restores header transforms for bash commands", async () => {
    const sandbox = makeSandbox("sbx_headers");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) }
      }
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
              Authorization: "Bearer token-1"
            }
          }
        ]
      }
    });

    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(1, {
      allow: {
        "*": [],
        "api.github.com": [
          {
            transform: [
              {
                headers: {
                  Authorization: "Bearer token-1"
                }
              }
            ]
          }
        ]
      }
    });
    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-c", 'export PATH="/vercel/sandbox/.junior/bin:$PATH" && echo ok'],
      cwd: "/vercel/sandbox"
    });
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(2, "allow-all");
  });

  it("merges header transforms into existing network policy allow rules", async () => {
    const sandbox = makeSandbox("sbx_policy_merge");
    sandbox.networkPolicy = {
      allow: {
        "example.com": [{ transform: [{ headers: { "X-Existing": "1" } }] }]
      }
    };
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) }
      }
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
              Authorization: "Bearer token-1"
            }
          }
        ]
      }
    });

    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(1, {
      allow: {
        "example.com": [{ transform: [{ headers: { "X-Existing": "1" } }] }],
        "api.github.com": [
          {
            transform: [
              {
                headers: {
                  Authorization: "Bearer token-1"
                }
              }
            ]
          }
        ]
      }
    });
    expect(sandbox.updateNetworkPolicy).toHaveBeenNthCalledWith(2, sandbox.networkPolicy);
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
        writeFile: { execute: vi.fn(async () => ({ success: true })) }
      }
    } as never);

    const executor = createSandboxExecutor({ sandboxId: "sbx_restore_failure" });
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
                Authorization: "Bearer token-1"
              }
            }
          ]
        }
      })
    ).rejects.toThrow("command failed");
    expect(sandbox.updateNetworkPolicy).toHaveBeenCalledTimes(2);
  });

  it("routes matching bash commands through custom command handler", async () => {
    const sandbox = makeSandbox("sbx_custom");
    sandboxGetMock.mockResolvedValue(sandbox);
    vi.mocked(createBashTool).mockResolvedValue({
      tools: {
        readFile: { execute: vi.fn(async () => ({ content: "" })) },
        writeFile: { execute: vi.fn(async () => ({ success: true })) }
      }
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
              stderr_truncated: false
            }
          }
        : { handled: false }
    );

    const executor = createSandboxExecutor({
      sandboxId: "sbx_custom",
      runBashCustomCommand
    });
    executor.configureSkills([]);

    const response = await executor.execute({
      toolName: "bash",
      input: {
        command: "jr-rpc issue-credential github.issues.write"
      }
    });

    expect(runBashCustomCommand).toHaveBeenCalledWith("jr-rpc issue-credential github.issues.write");
    expect(sandbox.runCommand).not.toHaveBeenCalled();
    expect(response.result).toMatchObject({
      ok: true,
      exit_code: 0
    });
  });
});
