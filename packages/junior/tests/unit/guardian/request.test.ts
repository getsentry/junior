import { describe, expect, it } from "vitest";
import { guardianMessages } from "@/chat/guardian/request";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { renderDataTag, TOP_LEVEL_AGENT_WRITER } from "@/chat/input-tags";

const agentMessage = (text: string) =>
  renderDataTag(
    "agent-message",
    { conversation_id: "conv-lead", source: "top_level_agent" },
    TOP_LEVEL_AGENT_WRITER,
    text,
  );

function proposal(userIntent: string): ToolActionProposal {
  return {
    context: {
      actor: { platform: "system", name: "event" },
      conversationId: "local:guardian-test",
      destination: {
        platform: "local",
        conversationId: "local:guardian-test",
      },
      source: {
        kind: "event",
        eventKey: "agent-message:conv-lead:1",
        eventType: "agent.top_level_message",
        identifier: "conv-lead",
        namespace: "junior",
      },
      userIntent,
    },
    input: {},
    tool: { description: "Close a PR.", name: "closePullRequest" },
  };
}

const watchProposal = (
  watch: NonNullable<ToolActionProposal["context"]["watch"]>,
): ToolActionProposal => {
  const base = proposal("<task>GitHub PR acme/app#1 was approved.</task>");
  return {
    ...base,
    context: {
      ...base.context,
      source: {
        kind: "event",
        eventKey: "pull_request.review.approved:1",
        eventType: "pull_request.review.approved",
        identifier: "acme/app#1",
        namespace: "github",
      },
      watch,
    },
  };
};

describe("guardianMessages", () => {
  it("gives another top-level agent's brief as the instruction, without its data notice", () => {
    const text = "Close #301 & #307 <now>.";
    expect(guardianMessages(proposal(agentMessage(text)))).toEqual([
      {
        from: "context",
        text: "[The agent of Conversation conv-lead sent this brief:]",
      },
      { from: "instruction", text },
    ]);
  });

  it("keeps the whole input when it holds more than agent messages", () => {
    const input = `${agentMessage("Close #301.")}\nextra`;
    expect(guardianMessages(proposal(input))).toEqual([
      { from: "instruction", text: input },
    ]);
  });

  it("makes the Watch intent the instruction and labels the Event author", () => {
    const person = { platform: "slack", teamId: "T1", userId: "U1" } as const;
    const event = (authorId: string | undefined, verified: boolean) => ({
      instructions: "Maintain acme/app#1. Fix review feedback and push.",
      about: "GitHub PR acme/app#1",
      trustedSummary: "A review comment was posted.",
      authorText: {
        text: "rename the flag",
        ...(authorId ? { authorId } : undefined),
        verified,
      },
    });
    const lines = (
      creator: NonNullable<ToolActionProposal["context"]["watch"]>["creator"],
      authorId: string | undefined,
      verified: boolean,
    ) =>
      guardianMessages(
        watchProposal({ creator, events: [event(authorId, verified)] }),
      );
    expect(lines({ actor: person, plugin: "github" }, "U2", true)).toEqual([
      {
        from: "instruction",
        text: "Watch intent (github plugin): Maintain acme/app#1. Fix review feedback and push.",
      },
      {
        from: "context",
        text: "Event: GitHub PR acme/app#1: A review comment was posted.",
      },
      { from: "other_person", text: "rename the flag" },
    ]);
    expect(lines({ actor: person }, "U1", true).at(-1)?.from).toBe(
      "instruction",
    );
    expect(lines({ actor: person }, undefined, false).at(-1)?.from).toBe(
      "context",
    );
  });
});
