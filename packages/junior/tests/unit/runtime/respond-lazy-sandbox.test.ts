import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  agentMode,
  createSandboxCallCount,
  activeSandboxVersion,
  sessionRecordPiMessages,
  selectedThinkingLevels,
} = vi.hoisted(() => ({
  agentMode: {
    value: "plain" as
      | "plain"
      | "loadSkill"
      | "attachFile"
      | "attachFileThenError"
      | "bashThenError",
  },
  createSandboxCallCount: {
    value: 0,
  },
  activeSandboxVersion: {
    value: 1,
  },
  sessionRecordPiMessages: {
    value: [] as unknown[],
  },
  selectedThinkingLevels: {
    value: [] as unknown[],
  },
}));

vi.mock("@earendil-works/pi-agent-core", () => {
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
        thinkingLevel?: unknown;
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
      selectedThinkingLevels.value.push(input.initialState.thinkingLevel);
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
    advisor: {
      modelId: "test-advisor-model",
      thinkingLevel: "xhigh",
    },
    fastModelId: "test-fast-model",
    modelId: "test-model",
    turnTimeoutMs: 1000,
    userName: "junior",
  },
  getRuntimeMetadata: () => ({ version: "test" }),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "test-provider",
  GEN_AI_SERVER_ADDRESS: "ai-gateway.vercel.sh",
  GEN_AI_SERVER_PORT: 443,
  completeObject: async ({ prompt }: { prompt: string }) => {
    const instructionMatch = prompt.match(
      /<current-instruction>\n([\s\S]*?)\n<\/current-instruction>/,
    );
    const instruction = instructionMatch?.[1] ?? "";

    if (instruction === "hello") {
      return {
        object: {
          thinking_level: "none",
          confidence: 1,
          reason: "ack",
        },
      };
    }
    if (instruction === "attach the report") {
      return {
        object: {
          thinking_level: "medium",
          confidence: 1,
          reason: "simple attachment request",
        },
      };
    }
    return {
      object: {
        thinking_level: "medium",
        confidence: 1,
        reason: "test-router",
      },
    };
  },
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

vi.mock("@/chat/services/turn-session-record", () => ({
  loadTurnSessionRecord: async () => ({
    resumedFromSessionRecord: false,
    currentSliceId: 1,
    existingSessionRecord:
      sessionRecordPiMessages.value.length > 0
        ? {
            piMessages: [...sessionRecordPiMessages.value],
          }
        : undefined,
    canUseTurnSession: false,
  }),
  persistCompletedSessionRecord: async () => undefined,
  persistAuthPauseSessionRecord: async () => ({
    version: 1,
    conversationId: "conversation-1",
    piMessages: [],
    sessionId: "turn-1",
    sliceId: 2,
    state: "awaiting_resume",
    updatedAtMs: 1,
  }),
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
  }) => {
    return {
      configureSkills: () => undefined,
      configureReferenceFiles: () => undefined,
      createSandbox: async () => {
        createSandboxCallCount.value += 1;
        const sandboxVersion = activeSandboxVersion.value;
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
        agentMode.value === "bashThenError" && toolName === "bash",
      execute: async ({ toolName }: { toolName: string; input: unknown }) => {
        if (toolName !== "bash") {
          throw new Error(
            "sandbox executor should not handle tools in this test",
          );
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
    };
  },
}));

import {
  generateAssistantReply,
  type ReplyRequestContext,
} from "@/chat/respond";

const LOCAL_DESTINATION = {
  platform: "local" as const,
  conversationId: "local:test:respond-lazy-sandbox",
};

function generateLocalReply(
  message: string,
  context: Omit<ReplyRequestContext, "destination"> = {},
) {
  return generateAssistantReply(message, {
    ...context,
    destination: LOCAL_DESTINATION,
  });
}

describe("generateAssistantReply lazy sandbox boot", () => {
  beforeEach(() => {
    agentMode.value = "plain";
    createSandboxCallCount.value = 0;
    activeSandboxVersion.value = 1;
    sessionRecordPiMessages.value = [];
    selectedThinkingLevels.value = [];
  });

  it("does not create a sandbox for turns that never touch sandbox-backed tools", async () => {
    const reply = await generateLocalReply("hello");

    expect(reply.text).toBe("Plain reply.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(reply.sandboxId).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual([]);
    expect(selectedThinkingLevels.value).toEqual(["off"]);
  });

  it("does not create a sandbox when loadSkill only reads host-side skill data", async () => {
    agentMode.value = "loadSkill";

    const reply = await generateLocalReply("load the demo skill");

    expect(reply.text).toBe("Loaded demo skill.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(reply.sandboxId).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual(["loadSkill"]);
    expect(selectedThinkingLevels.value).toEqual(["medium"]);
  });

  it("does not create a sandbox for restored skill history at turn start", async () => {
    sessionRecordPiMessages.value = [
      {
        role: "toolResult",
        toolName: "loadSkill",
        isError: false,
        details: {
          skill_name: "demo-skill",
        },
        content: [{ type: "text", text: "loaded" }],
      },
    ];

    const reply = await generateLocalReply("hello");

    expect(reply.text).toBe("Plain reply.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(reply.diagnostics.toolCalls).toEqual([]);
  });

  it("memoizes the lazy sandbox workspace across multiple workspace calls", async () => {
    agentMode.value = "attachFile";

    const reply = await generateLocalReply("attach the report");

    expect(reply.text).toBe("Attached report.");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.diagnostics.toolCalls).toEqual(["attachFile"]);
    expect(selectedThinkingLevels.value).toEqual(["medium"]);
  });

  it("retains sandbox reuse metadata after lazy boot on error turns", async () => {
    agentMode.value = "attachFileThenError";

    const reply = await generateLocalReply("attach the report");

    expect(reply.text).toContain("Error: agent exploded");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.sandboxId).toBe("sandbox-test");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-test");
  });

  it("reports sandbox metadata as soon as lazy boot succeeds on error turns", async () => {
    agentMode.value = "attachFileThenError";
    const onSandboxAcquired = vi.fn();

    const reply = await generateLocalReply("attach the report", {
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

    const reply = await generateLocalReply("run pwd");

    expect(reply.text).toContain("Error: agent exploded");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.sandboxId).toBe("sandbox-test");
    expect(reply.sandboxDependencyProfileHash).toBe("hash-test");
  });
});
