import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxOptions } from "@/chat/sandbox/sandbox";

const {
  captureRepositoryInstructionsMock,
  createSandboxMock,
  executeSandboxToolMock,
  executeCustomCommandMock,
  writeGeneratedArtifactsMock,
} = vi.hoisted(() => ({
  captureRepositoryInstructionsMock: vi.fn(),
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
  createPluginToolSandbox,
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
        captureRepositoryInstructions: captureRepositoryInstructionsMock,
        workspace,
        sandboxRef: () => input.sandboxRef,
        close: vi.fn(),
        tools: {
          supports: () => true,
          execute: executeSandboxToolMock,
        },
      };
    });
    captureRepositoryInstructionsMock.mockResolvedValue(undefined);
    executeCustomCommandMock.mockResolvedValue({ handled: false });
  });

  it("propagates repository instruction capture failures", async () => {
    const failure = new Error("repository instructions unavailable");
    captureRepositoryInstructionsMock.mockRejectedValue(failure);

    const sandbox = createAgentSandbox(options());

    await expect(sandbox.captureRepositoryInstructions()).rejects.toBe(failure);
  });

  it("surfaces preparing sandbox status to plugin bash callers", async () => {
    executeSandboxToolMock.mockResolvedValue({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "building",
            workspace: "sentry-docs",
            message:
              "The sentry-docs workspace is still preparing its sandbox. Wait for that preparation to finish, then try again.",
          }),
        },
      ],
      details: {
        status: "building",
        workspace: "sentry-docs",
        message:
          "The sentry-docs workspace is still preparing its sandbox. Wait for that preparation to finish, then try again.",
      },
    });
    const handleAuthSignal = vi.fn();
    const agentSandbox = createAgentSandbox(options());
    const pluginSandbox = createPluginToolSandbox(agentSandbox, {
      handleAuthSignal,
    });

    await expect(
      pluginSandbox.run({
        cmd: "pwd",
        cwd: "/vercel/sandbox",
      }),
    ).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr:
        "The sentry-docs workspace is still preparing its sandbox. Wait for that preparation to finish, then try again.",
    });
    expect(handleAuthSignal).toHaveBeenCalledWith(
      expect.objectContaining({ status: "building" }),
    );
  });

  it("routes plugin commands through sandbox auth and cancellation", async () => {
    const controller = new AbortController();
    const authRequired = {
      provider: "github",
      kind: "auth_required",
    };
    executeSandboxToolMock.mockResolvedValue({
      content: [{ type: "text", text: "clone failed" }],
      details: {
        exit_code: 1,
        stdout: "",
        stderr: "authentication required",
        auth_required: authRequired,
      },
    });
    const handleAuthSignal = vi
      .fn()
      .mockRejectedValue(new Error("authorization paused"));
    const agentSandbox = createAgentSandbox(options());
    const pluginSandbox = createPluginToolSandbox(agentSandbox, {
      handleAuthSignal,
    });

    await expect(
      pluginSandbox.run({
        cmd: "git",
        args: ["clone", "https://github.com/getsentry/junior.git"],
        cwd: "/vercel/sandbox",
        signal: controller.signal,
      }),
    ).rejects.toThrow("authorization paused");

    expect(executeSandboxToolMock).toHaveBeenCalledWith({
      toolName: "bash",
      input: {
        command: "'git' 'clone' 'https://github.com/getsentry/junior.git'",
        cwd: "/vercel/sandbox",
      },
      signal: controller.signal,
    });
    expect(handleAuthSignal).toHaveBeenCalledWith(
      expect.objectContaining({ auth_required: authRequired }),
    );
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
