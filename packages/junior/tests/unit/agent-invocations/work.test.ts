import { describe, expect, it } from "vitest";
import { agentInvocationSchema } from "@/chat/agent-invocations/types";
import { agentInvocationRunPolicy } from "@/chat/agent-invocations/work";

describe("agentInvocationRunPolicy", () => {
  it("uses the stored profile and reasoning on a fixed child route", () => {
    const invocation = agentInvocationSchema.parse({
      actor: { name: "agent", platform: "system" },
      childConversationId: "agent:child",
      createdAtMs: 1,
      destination: { conversationId: "local:test:child", platform: "local" },
      input: "Implement the change.",
      invocationId: "invocation-1",
      mailboxStatus: "pending",
      modelProfile: "handoff",
      parentConversationId: "agent:parent",
      reasoningLevel: "medium",
      source: { kind: "agent_invocation" },
      status: "pending",
      updatedAtMs: 1,
    });

    expect(agentInvocationRunPolicy(invocation, true)).toEqual({
      disabledFeatures: ["handoff", "interactive-auth"],
      modelProfile: "handoff",
      reasoning: "medium",
    });
  });
});
