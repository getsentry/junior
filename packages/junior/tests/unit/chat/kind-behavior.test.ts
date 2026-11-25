import { describe, expect, it } from "vitest";
import {
  isPersonInput,
  promptModeTurnTools,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";

const rootTurn = {
  delivery: "location",
  promptMode: "conversation",
  idleNeedsPendingWork: false,
  waitsForSignIn: true,
  gated: false,
  sessionTasks: true,
  conversationMetadata: true,
  relatedConversations: true,
  tools: {
    agents: "children",
    inbox: true,
    subscriptions: true,
    userCustomization: true,
    settings: true,
    reply: false,
    reportBlocked: "none",
    noReply: true,
  },
};

// Memory is public, so a Thread never captures it.
const personInThreadTurn = {
  ...rootTurn,
  promptMode: "thread",
  sender: "person",
  sessionTasks: false,
  relatedConversations: false,
  tools: { ...rootTurn.tools, agents: "children_and_parent" },
};

const agentInThreadTurn = {
  delivery: "conversation",
  promptMode: "thread",
  sender: "agent",
  idleNeedsPendingWork: false,
  waitsForSignIn: false,
  gated: false,
  sessionTasks: false,
  conversationMetadata: true,
  relatedConversations: false,
  tools: {
    agents: "children_and_parent",
    inbox: false,
    subscriptions: false,
    userCustomization: false,
    settings: false,
    reply: false,
    reportBlocked: "parent",
    // An agent's Turn reports to its parent with its final text.
    noReply: false,
  },
};

const { sender: _sender, ...childAgentTurn } = agentInThreadTurn;
const agentInTaskTurn = {
  ...childAgentTurn,
  promptMode: "child_agent",
  conversationMetadata: false,
};

// An Automation run almost never gets an answer, so only pending work keeps
// its cache warm.
const automationTurn = {
  delivery: "conversation",
  promptMode: "automation",
  sender: "automation",
  idleNeedsPendingWork: true,
  waitsForSignIn: true,
  gated: true,
  sessionTasks: true,
  conversationMetadata: true,
  relatedConversations: false,
  tools: {
    ...rootTurn.tools,
    settings: false,
    reply: true,
    reportBlocked: "automation",
  },
};

describe("turnBehavior", () => {
  it.each([
    { kind: "root", hasParent: false, personInput: true, expected: rootTurn },
    {
      kind: "root",
      hasParent: false,
      personInput: false,
      expected: {
        ...rootTurn,
        relatedConversations: false,
        tools: { ...rootTurn.tools, settings: false },
      },
    },
    // A person's reply in the run's thread runs like a root Turn.
    {
      kind: "automation",
      hasParent: false,
      personInput: true,
      expected: {
        ...rootTurn,
        promptMode: "automation",
        sender: "person",
        relatedConversations: false,
      },
    },
    // The dispatch Turn and every Watch Event Turn.
    {
      kind: "automation",
      hasParent: false,
      personInput: false,
      expected: automationTurn,
    },
    // A `root` with a parent is a Thread.
    {
      kind: "root",
      hasParent: true,
      personInput: true,
      expected: personInThreadTurn,
    },
    {
      kind: "root",
      hasParent: true,
      personInput: false,
      expected: agentInThreadTurn,
    },
    {
      kind: "task",
      hasParent: true,
      personInput: false,
      expected: agentInTaskTurn,
    },
  ] as const)(
    "gives a $kind Turn with a parent $hasParent and person input $personInput its behavior",
    ({ kind, hasParent, personInput, expected }) => {
      expect(turnBehavior({ kind, hasParent, personInput })).toEqual(expected);
    },
  );

  // A Thread lists the tools of both senders on every Turn, so its tool list
  // stays the same.
  it("lists the tools of both senders on every Turn of a Thread", () => {
    expect(promptModeTurnTools("thread")).toEqual({
      ...agentInThreadTurn.tools,
      inbox: true,
      subscriptions: true,
      userCustomization: true,
      settings: true,
      noReply: true,
    });
  });

  // A person's reply lists the run's tools, so the Automation Conversation's
  // tool list stays the same.
  it("lists the run's tools on every Turn of an Automation Conversation", () => {
    expect(promptModeTurnTools("automation")).toEqual(automationTurn.tools);
  });

  it("rejects a person's input on a task", () => {
    expect(() =>
      turnBehavior({ kind: "task", hasParent: true, personInput: true }),
    ).toThrow("A task Conversation cannot have a person's input");
  });

  // A Lead keeps one system prompt and one tool list on every Turn.
  it("gives every Turn of a Lead the same behavior", () => {
    const personTurn = turnBehavior({
      kind: "lead",
      hasParent: false,
      personInput: true,
    });
    expect(
      turnBehavior({ kind: "lead", hasParent: false, personInput: false }),
    ).toEqual(personTurn);
    expect(personTurn.promptMode).toBe("lead");
    expect(promptModeTurnTools("lead")).toEqual(personTurn.tools);
  });

  it("counts only Slack and web input as a person's", () => {
    expect(
      ["slack", "web", "event", "local", undefined].map(isPersonInput),
    ).toEqual([true, true, false, false, false]);
  });
});
