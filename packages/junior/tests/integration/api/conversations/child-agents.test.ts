import { afterEach, describe, expect, it } from "vitest";
import { createJuniorApi } from "@/api";
import { conversationChildAgentsReportSchema } from "@/api/schema";
import {
  completeAgentInvocation,
  createAgentInvocation,
} from "@/chat/agent-invocations/store";
import { closeDb } from "@/chat/db";
import {
  invocationInput,
  parentConversationId,
  prepareParentConversation,
  prepareSlackParentConversation,
  slackInvocationInput,
  slackParentConversationId,
} from "../../../fixtures/agent-invocations";

async function requestChildAgents(conversationId: string) {
  return await createJuniorApi().request(
    `http://localhost/api/conversations/${encodeURIComponent(conversationId)}/agents`,
  );
}

describe("conversation child agents API", () => {
  afterEach(async () => {
    await closeDb();
  });

  it("returns child agent state from agent invocation records", async () => {
    await prepareSlackParentConversation();
    const reviewer = await createAgentInvocation(
      {
        ...slackInvocationInput,
        agentName: "reviewer",
        idempotencyKey: "child-agents-reviewer",
        input: "Review the plan.",
        title: "Plan review",
      },
      1_000,
    );
    const blocked = await createAgentInvocation(
      {
        ...slackInvocationInput,
        idempotencyKey: "child-agents-blocked",
        input: "Read the private repo.",
      },
      2_000,
    );
    await completeAgentInvocation({
      errorMessage: "GitHub access is missing.",
      invocationId: blocked.invocationId,
      nowMs: 3_000,
      status: "blocked",
    });

    const response = await requestChildAgents(slackParentConversationId);

    expect(response.status).toBe(200);
    expect(
      conversationChildAgentsReportSchema.parse(await response.json()),
    ).toEqual({
      agents: [
        {
          conversationId: blocked.childConversationId,
          error: "GitHub access is missing.",
          status: "blocked",
          task: "Read the private repo.",
          updatedAt: new Date(3_000).toISOString(),
        },
        {
          conversationId: reviewer.childConversationId,
          name: "reviewer",
          status: "pending",
          task: "Review the plan.",
          title: "Plan review",
          updatedAt: new Date(1_000).toISOString(),
        },
      ],
      conversationId: slackParentConversationId,
    });
  });

  it("redacts child agent content from viewers without private access", async () => {
    await prepareParentConversation();
    const child = await createAgentInvocation(
      {
        ...invocationInput,
        agentName: "private-reviewer",
        idempotencyKey: "child-agents-private",
        title: "Private plan review",
      },
      1_000,
    );

    const response = await requestChildAgents(parentConversationId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        {
          conversationId: child.childConversationId,
          redacted: true,
          status: "pending",
          updatedAt: new Date(1_000).toISOString(),
        },
      ],
      conversationId: parentConversationId,
    });
  });
});
