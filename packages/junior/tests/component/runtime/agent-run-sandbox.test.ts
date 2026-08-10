import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalSource } from "@sentry/junior-plugin-api";

const {
  agentMode,
  createSandboxCallCount,
  activeSandboxVersion,
  preparedMessages,
  repositoryInstructionsAvailable,
  sessionRecordPiMessageProvenance,
  sessionRecordPiMessages,
  sessionRecordResumed,
  sessionRecordTurnStartMessageIndex,
  selectedThinkingLevels,
} = vi.hoisted(() => ({
  agentMode: {
    value: "plain" as
      | "plain"
      | "loadSkill"
      | "bashThenError"
      | "agentsAfterBash",
  },
  createSandboxCallCount: {
    value: 0,
  },
  activeSandboxVersion: {
    value: 1,
  },
  preparedMessages: {
    value: [] as unknown[],
  },
  repositoryInstructionsAvailable: {
    value: true,
  },
  sessionRecordPiMessageProvenance: {
    value: [] as unknown[],
  },
  sessionRecordPiMessages: {
    value: [] as unknown[],
  },
  sessionRecordResumed: {
    value: false,
  },
  sessionRecordTurnStartMessageIndex: {
    value: undefined as number | undefined,
  },
  selectedThinkingLevels: {
    value: [] as unknown[],
  },
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
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
    private prepareNextTurn?: (context: unknown) => Promise<unknown> | unknown;

    constructor(input: {
      prepareNextTurnWithContext?: (
        context: unknown,
      ) => Promise<unknown> | unknown;
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
      this.prepareNextTurn = input.prepareNextTurnWithContext;
      selectedThinkingLevels.value.push(input.initialState.thinkingLevel);
    }

    subscribe() {
      return () => undefined;
    }

    abort() {}

    async continue() {
      preparedMessages.value = [...this.state.messages];
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Plain reply." }],
        stopReason: "stop",
      });
      return {};
    }

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

      if (agentMode.value === "agentsAfterBash") {
        const bashTool = this.state.tools.find((tool) => tool.name === "bash");
        if (!bashTool) {
          throw new Error("bash tool missing");
        }
        const assistantMessage = {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-call-bash",
              name: "bash",
              arguments: { command: "git init repo" },
            },
          ],
          stopReason: "toolUse",
        };
        const toolResult = await bashTool.execute("tool-call-bash", {
          command: "git init repo",
        });
        this.state.messages.push(assistantMessage, {
          role: "toolResult",
          toolCallId: "tool-call-bash",
          toolName: "bash",
          content: [{ type: "text", text: JSON.stringify(toolResult) }],
          isError: false,
        });
        const update = (await this.prepareNextTurn?.({
          context: {
            messages: this.state.messages,
            systemPrompt: this.state.systemPrompt,
            tools: this.state.tools,
          },
          message: assistantMessage,
          newMessages: [],
          toolResults: [toolResult],
        })) as { context?: { messages?: unknown[] } } | undefined;
        if (update?.context?.messages) {
          this.state.messages = update.context.messages;
        }
        preparedMessages.value = [...this.state.messages];
      }

      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "Plain reply." }],
        stopReason: "stop",
      });
      return {};
    }
  }

  return { ...actual, Agent: MockAgent };
});

vi.mock("@/chat/config", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/chat/config")>();
  const memoryConfig = original.readChatConfig({
    ...process.env,
    AI_FAST_MODEL: "test-fast-model",
    AI_HANDOFF_MODEL: "test-handoff-model",
    AI_MODEL: "test-model",
    JUNIOR_STATE_ADAPTER: "memory",
  });
  return {
    ...original,
    botConfig: memoryConfig.bot,
    getChatConfig: () => memoryConfig,
    getRuntimeMetadata: () => ({ version: "test" }),
  };
});

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "test-provider",
  GEN_AI_SERVER_ADDRESS: "ai-gateway.vercel.sh",
  GEN_AI_SERVER_PORT: 443,
  completeObject: async ({ prompt }: { prompt: string }) => {
    const instructionMatch = prompt.match(
      /<current-instruction>\n([\s\S]*?)\n<\/current-instruction>/,
    );
    const instruction = instructionMatch?.[1] ?? "";

    if (prompt.includes("TypeError: x is undefined")) {
      return {
        object: {
          reasoning_level: "high",
          profile: "standard",
          confidence: 1,
          reason: "attachment stack trace",
        },
      };
    }
    if (instruction === "hello") {
      return {
        object: {
          reasoning_level: "none",
          profile: "standard",
          confidence: 1,
          reason: "ack",
        },
      };
    }
    if (instruction === "fix the failing test in chat") {
      return {
        object: {
          reasoning_level: "high",
          profile: "standard",
          confidence: 1,
          reason: "code change request",
        },
      };
    }
    return {
      object: {
        reasoning_level: "medium",
        profile: "standard",
        confidence: 1,
        reason: "test-router",
      },
    };
  },
  getGatewayApiKey: () => undefined,
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/prompt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/prompt")>()),
  buildSystemPrompt: () => "System prompt",
}));

vi.mock("@/chat/runtime/dev-agent-trace", () => ({
  shouldEmitDevAgentTrace: () => false,
}));

vi.mock("@/chat/conversations/projection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/conversations/projection")>()),
  loadConnectedMcpProviders: async () => [],
  openConversationProjection: async () => ({ modelProfile: "standard" }),
  recordMcpProviderConnected: async () => undefined,
  recordToolExecutionStarted: async () => undefined,
}));

vi.mock("@/chat/capabilities/factory", () => ({
  createUserTokenStore: () => ({
    get: async () => undefined,
    set: async () => undefined,
    delete: async () => undefined,
    withRefresh: async <T>(
      _userId: string,
      _provider: string,
      callback: () => Promise<T>,
    ) => callback(),
  }),
}));

vi.mock("@/chat/capabilities/jr-rpc-command", () => ({
  maybeExecuteJrRpcCustomCommand: async () => ({ handled: false }),
}));

vi.mock("@/chat/plugins/catalog-runtime", () => ({
  pluginCatalogRuntime: {
    getMcpProviders: () => [],
    getProviders: () => [],
  },
}));

vi.mock("@/chat/oauth-flow", () => ({
  extractOAuthStartedMessageFromToolResults: () => undefined,
}));

vi.mock("@/chat/task-execution/checkpoint", () => ({
  continuableMessages: (messages: unknown[]) => messages,
  loadTurnCheckpoint: async () => ({
    resumed: sessionRecordResumed.value,
    sliceId: 1,
    record:
      sessionRecordPiMessages.value.length > 0
        ? {
            piMessages: [...sessionRecordPiMessages.value],
            piMessageProvenance: [...sessionRecordPiMessageProvenance.value],
            ...(sessionRecordTurnStartMessageIndex.value !== undefined
              ? {
                  turnStartMessageIndex:
                    sessionRecordTurnStartMessageIndex.value,
                }
              : {}),
          }
        : undefined,
  }),
  saveTurnCheckpoint: async (args: { mode: string; sliceId?: number }) => {
    if (args.mode === "running") {
      return undefined;
    }
    if (args.mode === "paused") {
      return {
        version: 1,
        conversationId: "conversation-1",
        piMessages: [],
        sessionId: "turn-1",
        sliceId: (args.sliceId ?? 1) + 1,
        state: "paused",
        updatedAtMs: 1,
      };
    }
    return undefined;
  },
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
  createSandbox: (options: {
    onSandboxRefChanged?: (sandboxRef: {
      id: string;
      profileHash?: string;
    }) => void | Promise<void>;
    sandboxRef?: {
      id: string;
      profileHash?: string;
    };
  }) => {
    const acquire = async () => {
      createSandboxCallCount.value += 1;
      await options.onSandboxRefChanged?.({
        id:
          activeSandboxVersion.value === 1
            ? "sandbox-test"
            : `sandbox-test-${activeSandboxVersion.value}`,
        profileHash: "hash-test",
      });
    };
    return {
      captureRepositoryInstructions: async () =>
        repositoryInstructionsAvailable.value &&
        (options.sandboxRef || createSandboxCallCount.value > 0)
          ? {
              directory: "/vercel/sandbox/repo",
              fingerprint: `agents-v${activeSandboxVersion.value}`,
              sources: [
                {
                  path: "/vercel/sandbox/repo/AGENTS.md",
                  content:
                    activeSandboxVersion.value === 1
                      ? "Call retries the cobalt budget."
                      : "Use the current repository formatter.",
                },
              ],
              text:
                activeSandboxVersion.value === 1
                  ? "Call retries the cobalt budget."
                  : "Use the current repository formatter.",
            }
          : undefined,
      workspace: {
        readFileToBuffer: async () => {
          await acquire();
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
        runCommand: async () => {
          await acquire();
          return {
            exitCode: 0,
            stdout: "text/plain\n",
            stderr: "",
          };
        },
        writeFiles: async () => {
          await acquire();
        },
      },
      tools: {
        supports: (toolName: string) =>
          (agentMode.value === "bashThenError" ||
            agentMode.value === "agentsAfterBash") &&
          toolName === "bash",
        execute: async ({ toolName }: { toolName: string; input: unknown }) => {
          if (toolName !== "bash") {
            throw new Error(
              "sandbox executor should not handle tools in this test",
            );
          }

          if (
            agentMode.value !== "bashThenError" &&
            agentMode.value !== "agentsAfterBash"
          ) {
            throw new Error(
              "sandbox executor should not handle tools in this test",
            );
          }

          await acquire();
          return {
            command: "pwd",
            cwd: "/workspace",
            exit_code: 0,
            signal: null,
            timed_out: false,
            stdout: "/workspace\n",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
          };
        },
      },
      sandboxRef: () =>
        options.sandboxRef ??
        (createSandboxCallCount.value > 0
          ? {
              id:
                activeSandboxVersion.value === 1
                  ? "sandbox-test"
                  : `sandbox-test-${activeSandboxVersion.value}`,
              profileHash: "hash-test",
            }
          : undefined),
      close: vi.fn(),
    };
  },
}));

import { executeAgentRun } from "@/chat/agent";
import type { AgentRun } from "@/chat/agent/types";

const LOCAL_DESTINATION = {
  platform: "local" as const,
  conversationId: "local:test:agent-run-sandbox",
};
const LOCAL_SOURCE = createLocalSource(LOCAL_DESTINATION.conversationId);

async function generateLocalReply(
  message: string,
  context: Partial<Omit<AgentRun, "instruction" | "destination" | "source">> & {
    instruction?: Partial<Omit<AgentRun["instruction"], "text">>;
  } = {},
) {
  const { instruction: instructionOverrides, ...rest } = context;
  const outcome = await executeAgentRun({
    conversationId: context.conversationId ?? LOCAL_DESTINATION.conversationId,
    turnId: context.turnId ?? "turn-agent-run-sandbox",
    instruction: {
      text: message,
      ...instructionOverrides,
    },
    destination: LOCAL_DESTINATION,
    source: LOCAL_SOURCE,
    ...rest,
  });
  if (outcome.status !== "completed") {
    throw new Error(`Expected final reply, got ${outcome.status}`);
  }
  return outcome.result;
}

describe("executeAgentRun lazy sandbox boot", () => {
  beforeEach(() => {
    agentMode.value = "plain";
    createSandboxCallCount.value = 0;
    activeSandboxVersion.value = 1;
    preparedMessages.value = [];
    repositoryInstructionsAvailable.value = true;
    sessionRecordPiMessageProvenance.value = [];
    sessionRecordPiMessages.value = [];
    sessionRecordResumed.value = false;
    sessionRecordTurnStartMessageIndex.value = undefined;
    selectedThinkingLevels.value = [];
  });

  it("does not create a sandbox for turns that never touch sandbox-backed tools", async () => {
    const reply = await generateLocalReply("hello");

    expect(reply.text).toBe("Plain reply.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(reply.sandboxRef).toBeUndefined();
    expect(reply.diagnostics.toolCalls).toEqual([]);
    expect(selectedThinkingLevels.value).toEqual(["off"]);
  });

  it("does not create a sandbox when loadSkill only reads host-side skill data", async () => {
    agentMode.value = "loadSkill";

    const reply = await generateLocalReply("load the demo skill");

    expect(reply.text).toBe("Loaded demo skill.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(reply.sandboxRef).toBeUndefined();
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

  it("keeps restored AGENTS context when no sandbox is available", async () => {
    sessionRecordResumed.value = true;
    sessionRecordTurnStartMessageIndex.value = 0;
    sessionRecordPiMessages.value = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "# AGENTS.md instructions for /vercel/sandbox/repo\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>",
          },
        ],
        timestamp: 1,
      },
    ];
    sessionRecordPiMessageProvenance.value = [{ authority: "context" }];

    const reply = await generateLocalReply("resume the request");

    expect(reply.text).toBe("Plain reply.");
    expect(createSandboxCallCount.value).toBe(0);
    expect(JSON.stringify(preparedMessages.value)).toContain("Use pnpm.");
    expect(JSON.stringify(preparedMessages.value)).not.toContain(
      "no longer apply",
    );
  });

  it("removes restored AGENTS context when the repository is gone", async () => {
    repositoryInstructionsAvailable.value = false;
    sessionRecordResumed.value = true;
    sessionRecordTurnStartMessageIndex.value = 0;
    sessionRecordPiMessages.value = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "# AGENTS.md instructions for /vercel/sandbox/repo\n\n<INSTRUCTIONS>\nUse pnpm.\n</INSTRUCTIONS>",
          },
        ],
        timestamp: 1,
      },
    ];
    sessionRecordPiMessageProvenance.value = [{ authority: "context" }];

    const reply = await generateLocalReply("resume the request", {
      state: {
        sandboxRef: { id: "sandbox-test", profileHash: "hash-test" },
      },
    });

    expect(reply.text).toBe("Plain reply.");
    expect(JSON.stringify(preparedMessages.value)).toContain(
      "The previously provided AGENTS.md instructions no longer apply.",
    );
  });

  it("replaces replayed AGENTS context before a later model sample", async () => {
    agentMode.value = "agentsAfterBash";
    activeSandboxVersion.value = 2;
    const checkpointedContext = {
      role: "user",
      content: [
        {
          type: "text",
          text: "# AGENTS.md instructions for /vercel/sandbox/repo\n\n<INSTRUCTIONS>\nUse the old formatter.\n</INSTRUCTIONS>",
        },
      ],
      timestamp: 5,
    };
    const checkpointedInstruction = {
      role: "user",
      content: [
        {
          type: "text",
          text: "<current-instruction>\ncontinue the work\n</current-instruction>",
        },
      ],
      timestamp: 5,
    };
    sessionRecordTurnStartMessageIndex.value = 0;
    sessionRecordPiMessages.value = [
      checkpointedContext,
      checkpointedInstruction,
    ];
    sessionRecordPiMessageProvenance.value = [
      { authority: "context" },
      { authority: "instruction" },
    ];

    const reply = await generateLocalReply("continue the work", {
      history: [checkpointedContext, checkpointedInstruction] as never,
      state: {
        sandboxRef: { id: "sandbox-test", profileHash: "hash-test" },
      },
    });

    expect(reply.text).toBe("Plain reply.");
    expect(JSON.stringify(preparedMessages.value)).toContain(
      "Use the old formatter.",
    );
    expect(JSON.stringify(preparedMessages.value)).toContain(
      "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.",
    );
    expect(JSON.stringify(preparedMessages.value)).toContain(
      "Use the current repository formatter.",
    );
  });

  it("uses a high thinking level for explicit code-change asks", async () => {
    const reply = await generateLocalReply("fix the failing test in chat");

    expect(reply.text).toBe("Plain reply.");
    expect(selectedThinkingLevels.value).toEqual(["high"]);
  });

  it("uses attachment text when routing the turn thinking level", async () => {
    const reply = await generateLocalReply("can you fix this?", {
      instruction: {
        attachments: [
          {
            data: Buffer.from("TypeError: x is undefined\nat agent-run.ts:42"),
            filename: "error.txt",
            mediaType: "text/plain",
          },
        ],
      },
    });

    expect(reply.text).toBe("Plain reply.");
    expect(selectedThinkingLevels.value).toEqual(["high"]);
  });

  it("uses structured-suffix attachment text when the media type has parameters", async () => {
    const reply = await generateLocalReply("can you fix this?", {
      instruction: {
        attachments: [
          {
            data: Buffer.from("TypeError: x is undefined\nat agent-run.ts:42"),
            filename: "error.json",
            mediaType: "application/vnd.api+json; charset=utf-8",
          },
        ],
      },
    });

    expect(reply.text).toBe("Plain reply.");
    expect(selectedThinkingLevels.value).toEqual(["high"]);
  });

  it("retains and reports the sandbox reference after lazy boot on error turns", async () => {
    agentMode.value = "bashThenError";
    const onSandboxRefChanged = vi.fn();

    const reply = await generateLocalReply("run pwd", {
      durability: {
        onSandboxRefChanged,
      },
    });

    // Raw exception text stays in diagnostics; it is never reply text.
    expect(reply.text).toBe("");
    expect(reply.diagnostics.errorMessage).toContain("agent exploded");
    expect(createSandboxCallCount.value).toBe(1);
    expect(reply.sandboxRef).toEqual({
      id: "sandbox-test",
      profileHash: "hash-test",
    });
    expect(onSandboxRefChanged).toHaveBeenCalledTimes(1);
    expect(onSandboxRefChanged).toHaveBeenCalledWith({
      id: "sandbox-test",
      profileHash: "hash-test",
    });
  });

  it("adds newly available AGENTS.md instructions after a sandbox tool call", async () => {
    agentMode.value = "agentsAfterBash";

    const reply = await generateLocalReply("initialize the repository");

    expect(reply.text).toBe("Plain reply.");
    expect(JSON.stringify(preparedMessages.value)).toContain(
      "# AGENTS.md instructions for /vercel/sandbox/repo\\n\\n<INSTRUCTIONS>\\nCall retries the cobalt budget.\\n</INSTRUCTIONS>",
    );
    expect(JSON.stringify(preparedMessages.value)).not.toContain(
      '"stdout":"# AGENTS.md instructions',
    );
  });
});
