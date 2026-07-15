import { beforeEach, describe, expect, it, vi } from "vitest";

const { sandboxGetMock } = vi.hoisted(() => ({
  sandboxGetMock: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: {
    get: sandboxGetMock,
  },
}));

vi.mock("@/chat/sandbox/runtime-dependency-snapshots", () => ({
  getRuntimeDependencyProfileHash: () => "current-profile",
}));

import { createSandboxSessionManager } from "@/chat/sandbox/session";

function makeSandbox() {
  return {
    name: "sbx_adapter_contract",
    currentSession: vi.fn(() => ({
      sessionId: "sbx_adapter_contract_session",
    })),
    mkDir: vi.fn(async () => {}),
    writeFiles: vi.fn(async () => {}),
    readFileToBuffer: vi.fn(async () => Buffer.from("file content")),
    runCommand: vi.fn(async (params: { cmd: string; args?: string[] }) => ({
      exitCode: 0,
      stdout: async () =>
        params.cmd === "bash" &&
        params.args?.[0] === "-c" &&
        params.args[1]?.startsWith("ls /usr/bin")
          ? "grep\nsed\ncat\n"
          : "command stdout",
      stderr: async () => "",
    })),
    stop: vi.fn(async () => {}),
    extendTimeout: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ snapshotId: "snap_adapter_contract" })),
    update: vi.fn(async () => {}),
    fs: {},
  };
}

describe("bash-tool sandbox adapter", () => {
  beforeEach(() => {
    sandboxGetMock.mockReset();
  });

  it("lets real bash-tool initialize against Vercel Sandbox v2 shape", async () => {
    const sandbox = makeSandbox();
    sandboxGetMock.mockResolvedValue(sandbox);
    const manager = createSandboxSessionManager({
      sandboxId: "sbx_adapter_contract",
      sandboxDependencyProfileHash: "current-profile",
    });

    const executors = await manager.ensureToolExecutors();

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
