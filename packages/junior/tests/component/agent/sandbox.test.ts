import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxOptions } from "@/chat/sandbox/sandbox";

const {
  createSandboxMock,
  executeSandboxToolMock,
  executeCustomCommandMock,
  writeGeneratedArtifactsMock,
} = vi.hoisted(() => ({
  createSandboxMock: vi.fn(),
  executeSandboxToolMock: vi.fn(),
  executeCustomCommandMock: vi.fn(),
  writeGeneratedArtifactsMock: vi.fn(),
}));

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandbox: createSandboxMock,
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: executeCustomCommandMock,
}));

vi.mock("@/chat/discovery", () => ({
  listReferenceFiles: () => ["/tmp/reference.md"],
}));

vi.mock("@/chat/tools/sandbox/generated-artifacts", () => ({
  writeSandboxGeneratedArtifacts: writeGeneratedArtifactsMock,
}));

import {
  createAgentSandbox,
  type AgentSandboxOptions,
} from "@/chat/agent/sandbox";

const workspace = {
  readFileToBuffer: vi.fn(),
  runCommand: vi.fn(),
  writeFiles: vi.fn(),
};

function options(
  overrides: Partial<AgentSandboxOptions> = {},
): AgentSandboxOptions {
  return {
    skills: [],
    traceContext: {},
    configurationValues: {},
    getActiveSkill: () => null,
    prepareSandbox: vi.fn(),
    onSandboxRefChanged: vi.fn(),
    ...overrides,
  };
}

describe("createAgentSandbox", () => {
  let capturedOptions: SandboxOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    createSandboxMock.mockImplementation((input: SandboxOptions) => {
      capturedOptions = input;
      return {
        workspace,
        sandboxRef: () => input.sandboxRef,
        close: vi.fn(),
        tools: {
          supports: () => true,
          execute: executeSandboxToolMock,
        },
      };
    });
    executeCustomCommandMock.mockResolvedValue({ handled: false });
  });

  it("updates the run reference before awaiting durable persistence", async () => {
    const callOrder: string[] = [];
    createAgentSandbox(
      options({
        onSandboxRefChanged: () => {
          callOrder.push("run");
        },
        persistSandboxRef: async () => {
          callOrder.push("durable");
        },
      }),
    );

    await capturedOptions.onSandboxRefChanged?.({ id: "sandbox-1" });

    expect(callOrder).toEqual(["run", "durable"]);
    expect(capturedOptions.referenceFiles).toEqual(["/tmp/reference.md"]);
  });

  it("handles jr-rpc commands without touching the provider sandbox", async () => {
    executeCustomCommandMock.mockResolvedValue({
      handled: true,
      result: {
        ok: true,
        command: "jr-rpc config get github.repo",
        cwd: "/",
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout: "getsentry/junior\n",
        stderr: "",
        stdout_truncated: false,
        stderr_truncated: false,
      },
    });
    const sandbox = createAgentSandbox(options());

    const result = await sandbox.tools.execute({
      toolName: "bash",
      input: { command: "jr-rpc config get github.repo" },
    });

    expect(executeSandboxToolMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ details: { exit_code: 0 } });
  });

  it("forwards ordinary tools and generated artifacts", async () => {
    executeSandboxToolMock.mockResolvedValue({ cwd: "/workspace" });
    writeGeneratedArtifactsMock.mockResolvedValue([{ path: "/tmp/file.txt" }]);
    const sandbox = createAgentSandbox(options());
    const call = { toolName: "bash", input: { command: "pwd" } };

    await expect(sandbox.tools.execute(call)).resolves.toEqual({
      cwd: "/workspace",
    });
    await expect(sandbox.writeGeneratedArtifacts([])).resolves.toEqual([
      { path: "/tmp/file.txt" },
    ]);

    expect(executeSandboxToolMock).toHaveBeenCalledWith(call);
    expect(writeGeneratedArtifactsMock).toHaveBeenCalledWith(workspace, []);
  });
});
