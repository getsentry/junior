import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBashTool as createRealBashTool } from "bash-tool";

import { createSandboxSessionManager } from "@/chat/sandbox/session";
import { makeSandbox, sandboxGetMock } from "../../fixtures/sandbox-executor";

const createSandboxMock = vi.fn();
const resolveRuntimeDependencySnapshotMock = vi.fn();

function sandboxSessionServices() {
  return {
    createBashTool: createRealBashTool,
    createSandbox: createSandboxMock as never,
    getRuntimeDependencyProfileHash: () => undefined,
    getSandbox: sandboxGetMock as never,
    isSnapshotMissingError: () => false,
    resolveRuntimeDependencySnapshot:
      resolveRuntimeDependencySnapshotMock as never,
  };
}

describe("bash-tool sandbox adapter", () => {
  beforeEach(() => {
    createSandboxMock.mockReset();
    resolveRuntimeDependencySnapshotMock.mockReset();
    sandboxGetMock.mockReset();
  });

  it("lets real bash-tool initialize against Vercel Sandbox v2 shape", async () => {
    const sandbox = makeSandbox("sbx_adapter_contract");
    sandbox.readFileToBuffer.mockResolvedValue(Buffer.from("file content"));
    sandbox.runCommand.mockImplementation(
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
    sandboxGetMock.mockResolvedValue(sandbox);
    const manager = createSandboxSessionManager(
      { sandboxId: "sbx_adapter_contract" },
      sandboxSessionServices(),
    );

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
