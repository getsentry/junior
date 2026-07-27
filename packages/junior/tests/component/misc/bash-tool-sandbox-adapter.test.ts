import { beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxGetMock } = vi.hoisted(() => ({
  sandboxGetMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  FileSystem: class {
    private readonly fs: { stat(path: string): Promise<unknown> };

    constructor(session: { fs: { stat(path: string): Promise<unknown> } }) {
      this.fs = session.fs;
    }

    stat(path: string) {
      return this.fs.stat(path);
    }
  },
  Sandbox: {
    get: sandboxGetMock,
  },
}));

vi.mock("@/chat/sandbox/runtime-dependency-snapshots", () => ({
  resolveRuntimeDependencySnapshot: vi.fn(async () => ({
    dependencyCount: 0,
    cacheHit: false,
    resolveOutcome: "no_profile",
  })),
  getRuntimeDependencyProfileHash: () => "current-profile",
}));

import { createSandboxRuntime } from "@/chat/sandbox/session";

function makeSandbox() {
  const mkDir = vi.fn(async () => {});
  const writeFiles = vi.fn(async () => {});
  const readFileToBuffer = vi.fn(async () => Buffer.from("file content"));
  const runCommand = vi.fn(
    async (params: { cmd: string; args?: string[] }) => ({
      exitCode: 0,
      stdout: async () =>
        params.cmd === "bash" &&
        params.args?.[0] === "-c" &&
        params.args[1]?.startsWith("ls /usr/bin")
          ? "grep\nsed\ncat\n"
          : "command stdout",
      stderr: async () => "",
    }),
  );
  const stop = vi.fn(async () => {});
  const extendTimeout = vi.fn(async () => {});
  const snapshot = vi.fn(async () => ({
    snapshotId: "snap_adapter_contract",
  }));
  const update = vi.fn(async () => {});
  const fs = {
    stat: vi.fn(async () => ({ isDirectory: () => true })),
  };
  return {
    name: "sbx_adapter_contract",
    currentSession: vi.fn(() => ({
      sessionId: "sbx_adapter_contract_session",
      fs,
      mkDir,
      writeFiles,
      readFileToBuffer,
      runCommand,
      stop,
      extendTimeout,
      snapshot,
      update,
    })),
    mkDir,
    writeFiles,
    readFileToBuffer,
    runCommand,
    stop,
    extendTimeout,
    snapshot,
    update,
    fs,
  };
}

describe("bash-tool sandbox adapter", () => {
  beforeEach(() => {
    sandboxGetMock.mockReset();
  });

  it("lets real bash-tool initialize against Vercel Sandbox v2 shape", async () => {
    const sandbox = makeSandbox();
    sandboxGetMock.mockResolvedValue(sandbox);
    const manager = createSandboxRuntime({
      sandboxRef: {
        id: "sbx_adapter_contract",
        profileHash: "current-profile",
      },
      skills: [],
      referenceFiles: [],
    });

    const executors = await manager.tools();

    expect(sandbox.runCommand).toHaveBeenCalledWith({
      cmd: "bash",
      args: ["-c", expect.stringContaining("ls /usr/bin")],
    });
    await expect(executors.readFile({ path: "file.txt" })).resolves.toEqual({
      content: "file content",
    });
    await expect(
      executors.writeFile({ path: "out.txt", content: "written" }),
    ).resolves.toEqual({ success: true });

    expect(sandbox.readFileToBuffer).toHaveBeenCalledWith({
      path: "/vercel/sandbox/file.txt",
    });
    expect(sandbox.writeFiles).toHaveBeenCalledWith([
      {
        path: "/vercel/sandbox/out.txt",
        content: "written",
      },
    ]);
  });
});
