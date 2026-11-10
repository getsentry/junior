import { describe, expect, it } from "vitest";
import { agentInvocationSchema } from "@/chat/agent-invocations/types";
import { agentInvocationRunPolicy } from "@/chat/agent-invocations/work";

describe("agentInvocationRunPolicy", () => {
  it("uses the stored reasoning level for the child Run", () => {
    const invocation = agentInvocationSchema.parse({
      actor: { name: "agent", platform: "system" },
      childConversationId: "agent:child",
      createdAtMs: 1,
      destination: { conversationId: "local:test:child", platform: "local" },
      input: "Implement the change.",
      invocationId: "invocation-1",
      kind: "own_work",
      mailboxStatus: "pending",
      parentConversationId: "agent:parent",
      reasoningLevel: "medium",
      source: { kind: "agent_invocation" },
      status: "pending",
      updatedAtMs: 1,
    });

    expect(agentInvocationRunPolicy(invocation, true)).toEqual({
      disabledFeatures: ["interactive-auth"],
      reasoning: "medium",
    });
  });
});
