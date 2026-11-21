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
  failureNotice: "none",
  sessionTasks: true,
  tools: {
    agents: "children",
    inbox: true,
    subscriptions: true,
    userCustomization: true,
    reply: "none",
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
  tools: { ...rootTurn.tools, agents: "none" },
};

const agentInThreadTurn = {
  delivery: "conversation",
  promptMode: "thread",
  sender: "agent",
  idleNeedsPendingWork: false,
  waitsForSignIn: false,
  gated: true,
  failureNotice: "none",
  sessionTasks: false,
  tools: {
    agents: "children_and_parent",
    inbox: false,
    subscriptions: false,
    userCustomization: false,
    reply: "parent",
    reportBlocked: "parent",
    noReply: true,
  },
};

// A Task's parent learns that it failed or that no reply was sent.
const { sender: _sender, ...childAgentTurn } = agentInThreadTurn;
const agentInTaskTurn = {
  ...childAgentTurn,
  promptMode: "child_agent",
  missingAnswerError: "No reply was sent.",
  failureNotice: "parent",
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
  failureNotice: "none",
  sessionTasks: true,
  tools: {
    ...rootTurn.tools,
    reply: "automation",
    reportBlocked: "automation",
  },
};

describe("turnBehavior", () => {
  it.each([
    { kind: "root", personInput: true, expected: rootTurn },
    { kind: "root", personInput: false, expected: rootTurn },
    // A person's reply in the run's thread runs like a root Turn.
    {
      kind: "automation",
      personInput: true,
      expected: { ...rootTurn, promptMode: "automation", sender: "person" },
    },
    // The dispatch Turn and every Watch Event Turn.
    { kind: "automation", personInput: false, expected: automationTurn },
    { kind: "thread", personInput: true, expected: personInThreadTurn },
    { kind: "thread", personInput: false, expected: agentInThreadTurn },
    { kind: "task", personInput: false, expected: agentInTaskTurn },
  ] as const)(
    "gives a $kind Turn with person input $personInput its behavior",
    ({ kind, personInput, expected }) => {
      expect(turnBehavior({ kind, personInput })).toEqual(expected);
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
    });
  });

  // A person's reply lists the run's tools, so the Automation Conversation's
  // tool list stays the same.
  it("lists the run's tools on every Turn of an Automation Conversation", () => {
    expect(promptModeTurnTools("automation")).toEqual(automationTurn.tools);
  });

  it("rejects a person's input on a task", () => {
    expect(() => turnBehavior({ kind: "task", personInput: true })).toThrow(
      "A task Conversation cannot have a person's input",
    );
  });

  it("runs no Turn on a lead before its behavior exists", () => {
    expect(() => turnBehavior({ kind: "lead", personInput: true })).toThrow(
      "A lead Conversation has no Turn behavior yet",
    );
  });

  it("counts only Slack and web input as a person's", () => {
    expect(
      ["slack", "web", "event", "local", undefined].map(isPersonInput),
    ).toEqual([true, true, false, false, false]);
  });
});
