import { afterEach, describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  mockAnthropicStream,
  withoutCacheMarkers,
  type AnthropicRequest,
} from "../fixtures/anthropic-stream";
import { botConfig } from "@/chat/config";
import { closeConversationFixture } from "../fixtures/conversation";
import { createAgent } from "../fixtures/agent";
import {
  CONVERSATION_ID,
  createConversationWorkSlackHarness,
} from "../fixtures/conversation-work";
import { mockTitleModel } from "../fixtures/title-model";
import { createEventInboundMessage } from "@/chat/events/notification";
import { appendAndEnqueueInboundMessage } from "@/chat/task-execution/store";
import { resetSlackApiMockState } from "../msw/handlers/slack-api";

const originalBotConfig = { ...botConfig };

function toolNames(request: AnthropicRequest): string[] {
  return (request.tools as Array<{ name: string }>).map((tool) => tool.name);
}

describe("model message history", () => {
  afterEach(async () => {
    Object.assign(botConfig, originalBotConfig);
    await closeConversationFixture();
  });
  it("preserves native messages and provider request prefixes across Turns", async () => {
    const toolArguments = {
      explanation: "Check the result\u0000before replying.",
      plan: [
        { status: "in_progress", step: "Check the result" },
        { status: "pending", step: "Reply to the user" },
      ],
    };
    mockTitleModel("Conversation title");
    const requests = mockAnthropicStream("openai/gpt-6-astra", [
      [
        {
          type: "thinking",
          thinking: "Check the plan.",
          signature: "opaque-signature",
        },
        { type: "redacted_thinking", data: "opaque-redacted-data" },
        {
          type: "tool_use",
          id: "plan-call",
          name: "updatePlan",
          input: toolArguments,
        },
      ],
      [{ type: "text", text: "First response." }],
      [{ type: "text", text: "Second response." }],
    ]);
    const agent = await createAgent({
      modelStream: streamSimple,
      botConfig: {
        defaultProfile: "standard",
        profiles: {
          standard: { modelId: "openai/gpt-6-astra", reasoningLevel: "low" },
        },
      },
    });

    await agent.run("first\u0000request and literal \\u0000");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
    expect(first.messages).toContainEqual(
      expect.objectContaining({ role: "toolResult", isError: false }),
    );
    const firstAssistant = first.messages.find(
      (message) => message.role === "assistant",
    );
    expect(firstAssistant?.content).toMatchObject([
      { type: "thinking", thinkingSignature: "opaque-signature" },
      {
        type: "thinking",
        thinkingSignature: "opaque-redacted-data",
        redacted: true,
      },
      { type: "toolCall", arguments: toolArguments },
    ]);
    const stored = await agent.agentHistory();
    expect(
      JSON.stringify(
        stored.find((message) => message.role === "assistant")?.content,
      ),
    ).toBe(JSON.stringify(firstAssistant?.content));
    expect(stored.slice(0, first.messages.length)).toEqual(first.messages);
    expect(requests).toHaveLength(3);
    const before = requests[1]!;
    const after = requests[2]!;
    expect(JSON.stringify(after.system)).toBe(JSON.stringify(before.system));
    expect(JSON.stringify(after.tools)).toBe(JSON.stringify(before.tools));
    // Do not sort in the assertion: the real provider bytes must already match.
    expect(
      JSON.stringify(
        withoutCacheMarkers(after.messages.slice(0, before.messages.length)),
      ),
    ).toBe(JSON.stringify(withoutCacheMarkers(before.messages)));
  });

  it("keeps the provider request prefix when an event Turn follows a Slack Turn", async () => {
    resetSlackApiMockState();
    Object.assign(botConfig, {
      defaultProfile: "standard",
      profiles: {
        standard: { modelId: "openai/gpt-6-astra", reasoningLevel: "low" },
      },
    });
    const requests = mockAnthropicStream("openai/gpt-6-astra", [
      [{ type: "text", text: "Deploy checked." }],
      [
        {
          type: "tool_use",
          id: "disabled-call",
          name: "createEventAutomation",
          input: {
            instruction: "Fix failed checks.",
            trigger: {
              namespace: "github",
              identifier: "getsentry/junior#1563",
              resourceType: "pull_request",
              label: "PR #1563",
              events: ["pull_request.checks.failed"],
            },
          },
        },
      ],
      [{ type: "text", text: "Check failure noted." }],
    ]);
    const slack = await createConversationWorkSlackHarness({
      modelStream: streamSimple,
    });

    await slack.send();
    await slack.drain();
    // A Watch event in the same Slack thread starts a Turn with an event
    // Source and the event system Actor.
    await appendAndEnqueueInboundMessage({
      message: createEventInboundMessage({
        event: {
          eventKey: "checks-failed-1",
          eventType: "pull_request.checks.failed",
          identifier: "getsentry/junior#1563",
          namespace: "github",
          occurredAtMs: 1_100,
          trustedSummary: "The subscribed check failed.",
        },
        receivedAtMs: 1_100,
        subscription: {
          conversationId: CONVERSATION_ID,
          id: "resource-subscription-1",
        },
        text: "The subscribed check failed.",
      }),
      queue: slack.wakes,
      state: slack.state,
    });
    await slack.drain();

    expect(slack.replies()).toEqual([
      "Deploy checked.",
      "Check failure noted.",
    ]);
    expect(requests).toHaveLength(3);
    const [slackTurn, eventTurn, afterDisabledCall] = requests as [
      AnthropicRequest,
      AnthropicRequest,
      AnthropicRequest,
    ];
    // Anthropic caches tools, then system, then messages. A Turn origin must
    // not change any of them for the same Conversation.
    expect(toolNames(eventTurn)).toEqual(toolNames(slackTurn));
    expect(JSON.stringify(eventTurn.tools)).toBe(
      JSON.stringify(slackTurn.tools),
    );
    expect(JSON.stringify(eventTurn.system)).toBe(
      JSON.stringify(slackTurn.system),
    );
    expect(
      JSON.stringify(
        withoutCacheMarkers(
          eventTurn.messages.slice(0, slackTurn.messages.length),
        ),
      ),
    ).toBe(JSON.stringify(withoutCacheMarkers(slackTurn.messages)));
    // The event Turn cannot act for the person, so the runtime disables the
    // automation tools instead of removing them. The request tells the model,
    // and a call returns an error without running the tool.
    const eventTurnText = JSON.stringify(
      eventTurn.messages.slice(slackTurn.messages.length),
    );
    expect(eventTurnText).toContain("<disabled-tools>");
    expect(eventTurnText).toContain("createEventAutomation");
    expect(JSON.stringify(slackTurn.messages)).not.toContain(
      "createEventAutomation",
    );
    expect(JSON.stringify(afterDisabledCall.messages.at(-1))).toContain(
      "createEventAutomation is disabled in this Turn.",
    );
  });
});
