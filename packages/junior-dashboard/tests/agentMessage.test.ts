import type { ConversationReportEvent } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import {
  agentMessageConversation,
  receivedAgentMessage,
  sentAgentMessage,
} from "../src/client/conversations/agentMessage";
import type { TranscriptViewToolCallPart } from "../src/client/types";
import { mockReceivedAgentMessage } from "../src/mock-reporting/agent-messages";

function call(
  overrides: Partial<TranscriptViewToolCallPart>,
): TranscriptViewToolCallPart {
  return {
    id: "call-1",
    input: { text: "Check the cache too.", to: "reviewer" },
    name: "messageAgent",
    status: "completed",
    type: "tool_call",
    ...overrides,
  };
}

function result(delivery: string): string {
  return JSON.stringify({ conversation_id: "child-1", delivery });
}

describe("sentAgentMessage", () => {
  it("maps each tool result to a delivery state", () => {
    expect(sentAgentMessage(call({ output: result("started") }))).toEqual({
      conversationId: "child-1",
      delivery: "delivered",
      direction: "sent",
      text: "Check the cache too.",
      to: "reviewer",
    });
    expect(sentAgentMessage(call({ output: result("queued") }))?.delivery).toBe(
      "queued",
    );
    expect(sentAgentMessage(call({ output: result("noted") }))?.delivery).toBe(
      "noted",
    );
    expect(sentAgentMessage(call({ status: "running" }))?.delivery).toBe(
      "sending",
    );
    expect(
      sentAgentMessage(call({ output: "not reachable", status: "error" })),
    ).toMatchObject({ conversationId: undefined, delivery: "refused" });
  });

  it("shows no state for a result it cannot read", () => {
    expect(sentAgentMessage(call({ output: "{" }))).toMatchObject({
      conversationId: undefined,
      delivery: undefined,
    });
  });

  it("leaves other tools and hidden arguments to the tool row", () => {
    expect(sentAgentMessage(call({ name: "startAgent" }))).toBeUndefined();
    expect(sentAgentMessage(call({ input: undefined }))).toBeUndefined();
  });
});

describe("receivedAgentMessage", () => {
  it("reads the sender and the words without the model's tag", () => {
    const data = mockReceivedAgentMessage({
      messageId: "message-1",
      sender: {
        conversationId: "child-1",
        name: "reviewer",
        source: "child_agent",
        title: "Review the plan",
      },
      text: "Done. <b>Nothing</b> & no blockers.",
    });
    expect(
      receivedAgentMessage({
        ...data,
        parts: [{ type: "text", text: data.text ?? "" }],
      }),
    ).toEqual({
      conversationId: "child-1",
      direction: "received",
      text: "Done. <b>Nothing</b> & no blockers.",
    });
  });

  it("reads a Parent message as a message from the parent", () => {
    const role = "user" as const;
    expect(
      receivedAgentMessage({
        fromParentAgent: true,
        parentMessageText: "Check the cache too.",
        parts: [
          {
            text: "<parent-agent-task>\nReviewer instructions.\n\nCheck the cache too.\n</parent-agent-task>",
            type: "text",
          },
        ],
        role,
      }),
    ).toEqual({
      direction: "received",
      text: "Check the cache too.",
      to: "parent",
    });
    // A message saved before the parent's own words were kept.
    expect(
      receivedAgentMessage({
        fromParentAgent: true,
        parts: [
          {
            text: "<parent-agent-task>\nFirst.\n</parent-agent-task>\n\n<parent-agent-task>\nSecond.\n</parent-agent-task>",
            type: "text",
          },
        ],
        role,
      })?.text,
    ).toBe("First.\n\nSecond.");
    // A Watch Event that reached the child is not one.
    expect(
      receivedAgentMessage({
        eventType: "pull_request.checks.failed",
        fromParentAgent: true,
        parts: [{ text: "x", type: "text" }],
        role,
      }),
    ).toBeUndefined();
  });

  it("ignores other Event messages and keeps hidden text hidden", () => {
    const role = "user" as const;
    expect(
      receivedAgentMessage({
        eventIdentifier: "root-1",
        eventType: "agent.top_level_message",
        parts: [{ redacted: true, type: "text" }],
        role,
      }),
    ).toEqual({
      conversationId: "root-1",
      direction: "received",
      text: undefined,
    });
    expect(
      receivedAgentMessage({
        eventIdentifier: "root-1",
        eventType: "agent.update",
        parts: [{ text: "x", type: "text" }],
        role,
      }),
    ).toBeUndefined();
  });
});

describe("agentMessageConversation", () => {
  const subagent = (
    data: Partial<
      Extract<ConversationReportEvent["data"], { type: "subagent" }>
    >,
  ): ConversationReportEvent => ({
    createdAt: "2026-01-01T00:00:00.000Z",
    seq: 1,
    data: {
      type: "subagent",
      startedSeq: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      childConversationId: "child-1",
      childKind: "task",
      subagentKind: "agent",
      status: "completed",
      ...data,
    },
  });
  const tree = [
    { conversationId: "parent-1", kind: "thread" as const, label: "Plan" },
    { conversationId: "self", kind: "task" as const, label: "Self" },
  ];

  it("finds an ancestor in the agent tree", () => {
    const parent = { conversationId: "parent-1", title: "Plan" };
    expect(
      agentMessageConversation(
        { agentTree: tree, events: [] },
        { conversationId: "parent-1", to: "parent" },
      ),
    ).toEqual(parent);
    // A message to `parent` has no id before its result, and a Parent
    // message has none.
    expect(
      agentMessageConversation(
        { agentTree: tree, events: [] },
        { to: "parent" },
      ),
    ).toEqual(parent);
  });

  it("finds a child by id or by its agent name", () => {
    const events = [subagent({ agentName: "reviewer", title: "Review it" })];
    const child = { conversationId: "child-1", title: "Review it" };
    expect(
      agentMessageConversation(
        { events },
        { conversationId: "child-1", to: "child-1" },
      ),
    ).toEqual(child);
    // A sending call has no result yet, only the name it used.
    expect(agentMessageConversation({ events }, { to: "reviewer" })).toEqual(
      child,
    );
    expect(
      agentMessageConversation(
        { events: [subagent({ agentName: "reviewer" })] },
        { to: "reviewer" },
      ).title,
    ).toBe("reviewer");
  });

  it("uses a neutral label for a Conversation this transcript does not name", () => {
    expect(
      agentMessageConversation(
        { events: [subagent({ title: "Review it" })] },
        { conversationId: "root-9", to: "root-9" },
      ),
    ).toEqual({ conversationId: "root-9", title: "Conversation" });
  });
});
