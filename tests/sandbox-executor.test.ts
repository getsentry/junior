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

interface MockSandbox {
  sandboxId: string;
  mkDir: ReturnType<typeof vi.fn>;
  writeFiles: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  extendTimeout: ReturnType<typeof vi.fn>;
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
    stop: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {})
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
});
