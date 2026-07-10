import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  Agent: vi.fn().mockImplementation(function (this: {
    state: { messages: unknown[] };
    prompt: (message: unknown) => Promise<void>;
  }) {
    this.state = { messages: [] };
    this.prompt = vi.fn(async (message: unknown) => {
      this.state.messages.push(message);
      this.state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: "private advisor memo" }],
        stopReason: "stop",
        usage: { input: 5, output: 6, totalTokens: 11 },
      });
    });
  }),
  setSpanAttributes: vi.fn(),
  setSpanStatus: vi.fn(),
  withSpan: vi.fn(
    async (
      _name: string,
      _op: string,
      _context: Record<string, unknown>,
      callback: () => Promise<unknown>,
      _attributes?: Record<string, unknown>,
    ) => callback(),
  ),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: mocks.Agent,
}));

vi.mock("@/chat/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/chat/logging")>()),
  setSpanAttributes: mocks.setSpanAttributes,
  setSpanStatus: mocks.setSpanStatus,
  withSpan: mocks.withSpan,
}));

vi.mock("@/chat/pi/client", () => ({
  GEN_AI_PROVIDER_NAME: "vercel-ai-gateway",
  GEN_AI_SERVER_ADDRESS: "ai-gateway.vercel.sh",
  GEN_AI_SERVER_PORT: 443,
  getPiGatewayApiKey: vi.fn(() => undefined),
  resolveGatewayModel: vi.fn((modelId: string) => ({ id: modelId })),
}));

describe("createAdvisorTool", () => {
  it("records privacy-safe advisor invoke-agent attributes", async () => {
    const { createAdvisorTool } = await import("@/chat/tools/advisor/tool");
    const advisor = createAdvisorTool({
      config: {
        modelId: "openai/gpt-5.4",
        thinkingLevel: "low",
      },
      conversationId: "slack:D1:123",
      conversationPrivacy: "private",
      getTools: () => [],
      conversationStore: {
        ensureChildConversation: async () => undefined,
      } as unknown as import("@/chat/conversations/store").ConversationStore,
    });

    const result = await advisor.execute!(
      {
        question: "private question",
        context: "private context",
      },
      {},
    );

    expect(result).toMatchObject({ ok: true, status: "success" });
    const startAttributes = mocks.withSpan.mock.calls[0]?.[4] as Record<
      string,
      unknown
    >;
    expect(startAttributes).toMatchObject({
      "gen_ai.provider.name": "vercel-ai-gateway",
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": "openai/gpt-5.4",
      "gen_ai.output.type": "text",
      "server.address": "ai-gateway.vercel.sh",
      "server.port": 443,
      "app.conversation.privacy": "private",
      "app.ai.input.message_count": 1,
    });
    expect(startAttributes["gen_ai.input.messages"]).toContain('"chars"');
    expect(startAttributes["gen_ai.input.messages"]).not.toContain(
      "private question",
    );
    expect(startAttributes["gen_ai.input.messages"]).not.toContain(
      "private context",
    );

    const endAttributes = mocks.setSpanAttributes.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(endAttributes["app.ai.output.message_count"]).toBe(1);
    expect(endAttributes["gen_ai.output.messages"]).toContain('"chars"');
    expect(endAttributes["gen_ai.output.messages"]).not.toContain(
      "private advisor memo",
    );
  }, 20_000);
});
