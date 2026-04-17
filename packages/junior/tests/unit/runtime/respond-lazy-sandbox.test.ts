import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentMode,
  createSandboxCallCount,
  activeSandboxVersion,
  attachFileReadVersions,
  enabledCredentialSkillNames,
  checkpointLoadedSkillNames,
  pendingWorkspaceRelease,
} = vi.hoisted(() => ({
  agentMode: {
    value: "plain" as
      | "plain"
      | "loadSkill"
      | "attachFile"
      | "attachFileThenError"
      | "attachFileBashRecoverAttachFile"
      | "attachFileBashRaceAttachFile"
      | "bashThenError",
  },
  createSandboxCallCount: {
    value: 0,
  },
  activeSandboxVersion: {
    value: 1,
  },
  attachFileReadVersions: {
    value: [] as number[],
  },
  enabledCredentialSkillNames: {
    value: [] as string[],
  },
  checkpointLoadedSkillNames: {
    value: [] as string[],
  },
  pendingWorkspaceRelease: {
    value: undefined as (() => void) | undefined,
  },
}));

vi.mock("@mariozechner/pi-agent-core", () => {
  class MockAgent {
    state: {
      messages: unknown[];
      model: unknown;
      systemPrompt: string;
      tools: Array<{
        name: string;
        execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
      }>;
    };

    constructor(input: {
      initialState: {
        model: unknown;
        systemPrompt: string;
        tools: Array<{
          name: string;
          execute: (toolCallId: unknown, params: unknown) => Promise<unknown>;
        }>;
      };
    }) {
      this.state = {
        messages: [],
        model: input.initialState.model,
        systemPrompt: input.initialState.systemPrompt,
        tools: input.initialState.tools,
      };
    }

    subscribe() {
      return () => undefined;
    }

    abort() {}

    async prompt(message: unknown) {
      this.state.messages.push(message);

      if (agentMode.value === "loadSkill") {
        const loadSkillTool = this.state.tools.find(
          (tool) => tool.name === "loadSkill",
        );
        if (!loadSkillTool) {
          throw new Error("loadSkill tool missing");
        }
        await loadSkillTool.execute("tool-call-load-skill", {
          skill_name: "demo-skill",
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Loaded demo skill." }],
          stopReason: "stop",
        });
        return {};
      }

      if (agentMode.value === "attachFile") {
        const attachFileTool = this.state.tools.find(
          (tool) => tool.name === "attachFile",
        );
        if (!attachFileTool) {
          throw new Error("attachFile tool missing");
        }
        await attachFileTool.execute("tool-call-attach-file", {
          path: "report.txt",
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Attached report." }],
          stopReason: "stop",
        });
        return {};
      }

      if (agentMode.value === "attachFileThenError") {
        const attachFileTool = this.state.tools.find(
          (tool) => tool.name === "attachFile",
        );
        if (!attachFileTool) {
          throw new Error("attachFile tool missing");
        }
        await attachFileTool.execute("tool-call-attach-file", {
          path: "report.txt",
        });
        throw new Error("agent exploded");
      }

      if (agentMode.value === "attachFileBashRecoverAttachFile") {
        const attachFileTool = this.state.tools.find(
          (tool) => tool.name === "attachFile",
        );
        const bashTool = this.state.tools.find((tool) => tool.name === "bash");
        if (!attachFileTool || !bashTool) {
          throw new Error("sandbox-backed tools missing");
        }
        await attachFileTool.execute("tool-call-attach-file-1", {
          path: "report.txt",
        });
        await bashTool.execute("tool-call-bash", {
          command: "pwd",
        });
        await attachFileTool.execute("tool-call-attach-file-2", {
          path: "report.txt",
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Attached report twice." }],
          stopReason: "stop",
        });
        return {};
      }

      if (agentMode.value === "attachFileBashRaceAttachFile") {
        const attachFileTool = this.state.tools.find(
          (tool) => tool.name === "attachFile",
        );
        const bashTool = this.state.tools.find((tool) => tool.name === "bash");
        if (!attachFileTool || !bashTool) {
          throw new Error("sandbox-backed tools missing");
        }
        const firstAttach = attachFileTool.execute("tool-call-attach-file-1", {
          path: "report.txt",
        });
        await bashTool.execute("tool-call-bash", {
          command: "pwd",
        });
        await firstAttach;
        await attachFileTool.execute("tool-call-attach-file-2", {
          path: "report.txt",
        });
        this.state.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "Attached report after race." }],
          stopReason: "stop",
        });
        return {};
      }

      if (agentMode.value === "bashThenError") {
        const bashTool = this.state.tools.find((tool) => tool.name === "bash");
        if (!bashTool) {
          throw new Error("bash tool missing");
        }
        await bashTool.execute("tool-call-bash", {
          command: "pwd",
        });
        throw new Error("agent exploded");
      }

      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Plain reply." }],
        stopReason: "stop",
      });
      return {};
    }
  }

  return { Agent: MockAgent };
});

vi.mock("@/chat/config", () => ({
  botConfig: {
    modelId: "test-model",
    turnTimeoutMs: 1000,
  },
  getRuntimeMetadata: () => ({ version: "test" }),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "test-provider",
  getPiGatewayApiKeyOverride: () => undefined,
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/prompt")>()),
  buildSystemPrompt: () => "System prompt",
}));

vi.mock("@/chat/runtime/dev-agent-trace", () => ({
  shouldEmitDevAgentTrace: () => false,
}));

vi.mock("@/chat/capabilities/factory", () => ({
  createSkillCapabilityRuntime: () => ({
    enableCredentialsForTurn: async (input: {
      activeSkill: { name?: string } | null;
    }) => {
      const skillName = input.activeSkill?.name;
      if (skillName) {
        enabledCredentialSkillNames.value.push(skillName);
      }
      return undefined;
    },
    getTurnHeaderTransforms: () => undefined,
    getTurnEnv: () => undefined,
  }),
  createUserTokenStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
  }),
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: async () => ({ handled: false }),
}));

vi.mock("@/chat/plugins/registry", () => ({
  getPluginMcpProviders: () => [],
  getPluginProviders: () => [],
}));

vi.mock("@/chat/oauth-flow", () => ({
  extractOAuthStartedMessageFromToolResults: () => undefined,
}));

vi.mock("@/chat/services/turn-checkpoint", () => ({
  loadTurnCheckpoint: async () => ({
    resumedFromCheckpoint: false,
    currentSliceId: 1,
    existingCheckpoint:
      checkpointLoadedSkillNames.value.length > 0
        ? {
            loadedSkillNames: [...checkpointLoadedSkillNames.value],
            piMessages: [],
          }
        : undefined,
    canUseTurnSession: false,
  }),
  persistCompletedCheckpoint: async () => undefined,
  persistAuthPauseCheckpoint: async () => 2,
}));

vi.mock("@/chat/services/mcp-auth-orchestration", () => {
  class MockMcpAuthorizationPauseError extends Error {}

  return {
    McpAuthorizationPauseError: MockMcpAuthorizationPauseError,
    createMcpAuthOrchestration: () => ({
      authProviderFactory: async () => undefined,
      onAuthorizationRequired: async () => undefined,
      getPendingPause: () => undefined,
    }),
  };
});

vi.mock("@/chat/skills", () => {
  const metadata = {
    name: "demo-skill",
    description: "Demo skill",
    skillPath: "/tmp/skills/demo-skill",
    pluginProvider: "demo",
  };

  return {
    discoverSkills: async () => [metadata],
    findSkillByName: () => null,
    loadSkillsByName: async () => [
      {
        ...metadata,
        body: "Skill instructions",
      },
    ],
    parseSkillInvocation: () => null,
    stripFrontmatter: (value: string) =>
      value.replace(/^---[\s\S]*?---\s*/, "").trim(),
  };
});

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandboxExecutor: (options?: {
    onSandboxAcquired?: (sandbox: {
      sandboxId: string;
      sandboxDependencyProfileHash?: string;
    }) => void | Promise<void>;
  }) => ({
    configureSkills: () => undefined,
    configureReferenceFiles: () => undefined,
    createSandbox: async () => {
      createSandboxCallCount.value += 1;
      const sandboxVersion = activeSandboxVersion.value;
      if (
        agentMode.value === "attachFileBashRaceAttachFile" &&
        createSandboxCallCount.value === 1
      ) {
        await new Promise<void>((resolve) => {
          pendingWorkspaceRelease.value = resolve;
        });
        pendingWorkspaceRelease.value = undefined;
      }
      await options?.onSandboxAcquired?.({
        sandboxId:
          sandboxVersion === 1
            ? "sandbox-test"
            : `sandbox-test-${sandboxVersion}`,
        sandboxDependencyProfileHash: "hash-test",
      });
      return {
        sandboxId:
          sandboxVersion === 1
            ? "sandbox-test"
            : `sandbox-test-${sandboxVersion}`,
        readFileToBuffer: async () => {
          attachFileReadVersions.value.push(sandboxVersion);
          return Buffer.from(
            [
              "---",
              "name: demo-skill",
              "description: Demo skill",
              "---",
              "",
              "Skill instructions",
            ].join("\n"),
            "utf8",
          );
        },
        runCommand: async () => ({
          exitCode: 0,
          stdout: async () => "text/plain\n",
          stderr: async () => "",
        }),
      };
    },
    canExecute: (toolName: string) =>
      (agentMode.value === "bashThenError" ||
        agentMode.value === "attachFileBashRecoverAttachFile" ||
        agentMode.value === "attachFileBashRaceAttachFile") &&
      toolName === "bash",
    execute: async ({ toolName }: { toolName: string; input: unknown }) => {
      if (toolName !== "bash") {
        throw new Error(
          "sandbox executor should not handle tools in this test",
        );
      }

      if (agentMode.value === "attachFileBashRecoverAttachFile") {
        activeSandboxVersion.value += 1;
        return {
          result: {
            ok: true,
            command: "pwd",
            cwd: "/workspace",
            exit_code: 0,
            signal: null,
            timed_out: false,
            stdout: "/workspace\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
          },
        };
      }

      if (agentMode.value === "attachFileBashRaceAttachFile") {
        activeSandboxVersion.value += 1;
        pendingWorkspaceRelease.value?.();
        return {
          result: {
            ok: true,
            command: "pwd",
            cwd: "/workspace",
            exit_code: 0,
            signal: null,
            timed_out: false,
            stdout: "/workspace\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
          },
        };
      }

      if (agentMode.value !== "bashThenError") {
        throw new Error(
          "sandbox executor should not handle tools in this test",
        );
      }

      createSandboxCallCount.value += 1;
      await options?.onSandboxAcquired?.({
        sandboxId:
          activeSandboxVersion.value === 1
            ? "sandbox-test"
            : `sandbox-test-${activeSandboxVersion.value}`,
        sandboxDependencyProfileHash: "hash-test",
      });
      return {
        result: {
          ok: true,
          command: "pwd",
          cwd: "/workspace",
          exit_code: 0,
          signal: null,
          timed_out: false,
          stdout: "/workspace\n",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
        },
      };
    },
    getSandboxId: () =>
      createSandboxCallCount.value > 0
        ? activeSandboxVersion.value === 1
          ? "sandbox-test"
          : `sandbox-test-${activeSandboxVersion.value}`
        : undefined,
    getDependencyProfileHash: () => "hash-test",
    dispose: async () => undefined,
  }),
}));

import { generateAssistantReply } from "@/chat/respond";

describe("generateAssistantReply lazy sandbox boot", () => {
  beforeEach(() => {
    agentMode.value = "plain";
    createSandboxCallCount.value = 0;
    activeSandboxVersion.value = 1;
    attachFileReadVersions.value = [];
    enabledCredentialSkillNames.value = [];
    checkpointLoadedSkillNames.value = [];
    pendingWorkspaceRelease.value = undefined;
  });

  it("does not create a sandbox for turns that never touch sandbox-backed tools", async () => {
    const reply = await generateAssistantReply("hello");

    expect(reply.text).toBe("Plain reply.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(reply.sandboxId).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual([]);
  });

  it("does not create a sandbox when loadSkill only reads host-side skill data", async () => {
    agentMode.value = "loadSkill";

    const reply = await generateAssistantReply("load the demo skill");

    expect(reply.text).toBe("Loaded demo skill.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(enabledCredentialSkillNames.value).toEqual(["demo-skill"]);
    expect(reply.sandboxId).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual(["loadSkill"]);
  });

  it("reprovisions plugin credentials for checkpoint-loaded skills at turn start", async () => {
    checkpointLoadedSkillNames.value = ["demo-skill"];

    const reply = await generateAssistantReply("hello");

    expect(reply.text).toBe("Plain reply.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(enabledCredentialSkillNames.value).toEqual(["demo-skill"]);
    expect(reply.diagnostics.toolCalls).toEqual([]);
  });

  it("memoizes the lazy sandbox workspace across multiple workspace calls", async () => {
    agentMode.value = "attachFile";

    const reply = await generateAssistantReply("attach the report");

    expect(reply.text).toBe("Attached report.");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.diagnostics.toolCalls).toEqual(["attachFile"]);
  });

  it("retains sandbox reuse metadata after lazy boot on error turns", async () => {
    agentMode.value = "attachFileThenError";

    const reply = await generateAssistantReply("attach the report");

    expect(reply.text).toContain("Error: agent exploded");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.sandboxId).toBe("sandbox-test");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-test");
  });

  it("reports sandbox metadata as soon as lazy boot succeeds on error turns", async () => {
    agentMode.value = "attachFileThenError";
    const onSandboxAcquired = vi.fn();

    const reply = await generateAssistantReply("attach the report", {
      onSandboxAcquired,
    });

    expect(reply.text).toContain("Error: agent exploded");
    expect(onSandboxAcquired).toHaveBeenCalledTimes(1);
    expect(onSandboxAcquired).toHaveBeenCalledWith({
      sandboxId: "sandbox-test",
      sandboxDependencyProfileHash: "hash-test",
    });
  });

  it("retains sandbox reuse metadata after executor-backed boot on error turns", async () => {
    agentMode.value = "bashThenError";

    const reply = await generateAssistantReply("run pwd");

    expect(reply.text).toContain("Error: agent exploded");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.sandboxId).toBe("sandbox-test");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-test");
  });

  it("refreshes the cached workspace after sandbox replacement", async () => {
    agentMode.value = "attachFileBashRecoverAttachFile";

    const reply = await generateAssistantReply("attach the report twice");

    expect(reply.text).toBe("Attached report twice.");
    expect(createSandboxCallCount.value).toBe(2);
    expect(attachFileReadVersions.value).toEqual([1, 2]);
    expect(reply.sandboxId).toBe("sandbox-test-2");
    expect(reply.diagnostics.toolCalls).toEqual([
      "attachFile",
      "bash",
      "attachFile",
    ]);
  });

  it("refreshes the cached workspace when sandbox replacement races with lazy boot", async () => {
    agentMode.value = "attachFileBashRaceAttachFile";

    const reply = await generateAssistantReply(
      "attach the report after a race",
    );

    expect(reply.text).toBe("Attached report after race.");
    expect(createSandboxCallCount.value).toBe(2);
    expect(attachFileReadVersions.value).toEqual([1, 2]);
    expect(reply.sandboxId).toBe("sandbox-test-2");
    expect(reply.diagnostics.toolCalls).toEqual([
      "attachFile",
      "bash",
      "attachFile",
    ]);
  });
});
