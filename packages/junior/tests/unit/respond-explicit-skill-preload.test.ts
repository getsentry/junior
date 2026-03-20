import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetPluginRegistryForTests,
  setAdditionalPluginRootsForTests,
} from "@/chat/plugins/registry";
import { resetSkillDiscoveryCache } from "@/chat/skills";

const { capturedActiveSkillNames } = vi.hoisted(() => ({
  capturedActiveSkillNames: [] as string[][],
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
        tools: [...input.initialState.tools],
      };
    }

    subscribe() {
      return () => undefined;
    }

    abort() {}

    async prompt(message: unknown) {
      this.state.messages.push(message);
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stopReason: "stop",
      });
      return {};
    }
  }

  return { Agent: MockAgent };
});

vi.mock("@/chat/observability", () => ({
  logException: vi.fn(),
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  setSpanAttributes: vi.fn(),
  setSpanStatus: vi.fn(),
  setTags: vi.fn(),
  withSpan: async (
    _name: string,
    _op: string,
    _context: unknown,
    callback: () => Promise<unknown>,
  ) => await callback(),
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
  getGatewayApiKey: () => "test-gateway-key",
  resolveGatewayModel: (modelId: string) => modelId,
}));

vi.mock("@/chat/prompt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/chat/prompt")>();
  return {
    ...actual,
    buildSystemPrompt: (
      params: Parameters<typeof actual.buildSystemPrompt>[0],
    ) => {
      capturedActiveSkillNames.push(
        params.activeSkills.map((skill) => skill.name),
      );
      return "System prompt";
    },
  };
});

vi.mock("@/chat/runtime/dev-agent-trace", () => ({
  shouldEmitDevAgentTrace: () => false,
}));

vi.mock("@/chat/runtime-metadata", () => ({
  getRuntimeMetadata: () => ({ version: "test" }),
}));

vi.mock("@/chat/sandbox/sandbox", () => ({
  createSandboxExecutor: () => ({
    configureSkills: () => undefined,
    createSandbox: async () => ({}),
    canExecute: () => false,
    execute: async () => {
      throw new Error("sandbox executor should not execute in preload test");
    },
    getSandboxId: () => "sandbox-test",
    getDependencyProfileHash: () => "hash-test",
    dispose: async () => undefined,
  }),
}));

import { generateAssistantReply } from "@/chat/respond";

describe("generateAssistantReply explicit skill preload", () => {
  beforeEach(() => {
    capturedActiveSkillNames.length = 0;
    resetPluginRegistryForTests();
    setAdditionalPluginRootsForTests([
      path.resolve(process.cwd(), "evals/plugins"),
    ]);
    resetSkillDiscoveryCache();
  });

  afterEach(() => {
    resetPluginRegistryForTests();
    resetSkillDiscoveryCache();
  });

  it("preloads explicitly invoked eval plugin skills into the system prompt", async () => {
    await generateAssistantReply(
      "/eval-oauth Connect the demo account, then tell me what budget deadline I mentioned earlier.",
      {
        requester: { userId: "U_TEST" },
        correlation: {
          channelId: "C_TEST",
          threadTs: "1700000000.0001",
          requesterId: "U_TEST",
        },
      },
    );

    expect(
      capturedActiveSkillNames.some((names) => names.includes("eval-oauth")),
    ).toBe(true);
  });
});
