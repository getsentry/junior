import { describe, expect, it } from "vitest";
import {
  isPersonInput,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";

const rootTurn = {
  delivery: "location",
  promptMode: "conversation",
  gated: false,
  tools: {
    agents: "children",
    reviewDesk: true,
    subscriptions: true,
    userCustomization: true,
    reply: false,
    reportBlocked: "none",
    noReply: true,
  },
};

const personInThreadTurn = {
  ...rootTurn,
  tools: { ...rootTurn.tools, agents: "none" },
};

const childAgentTurn = {
  delivery: "conversation",
  promptMode: "child_agent",
  gated: false,
  tools: {
    agents: "children_and_parent",
    reviewDesk: false,
    subscriptions: false,
    userCustomization: false,
    reply: false,
    reportBlocked: "parent",
    noReply: true,
  },
};

const automationTurn = {
  delivery: "conversation",
  promptMode: "automation",
  gated: true,
  tools: { ...rootTurn.tools, reply: true, reportBlocked: "automation" },
};

describe("turnBehavior", () => {
  it.each([
    { kind: "root", personInput: true, expected: rootTurn },
    { kind: "root", personInput: false, expected: rootTurn },
    // A person's reply in the run's thread.
    { kind: "automation", personInput: true, expected: rootTurn },
    // The dispatch Turn and every Watch Event Turn.
    { kind: "automation", personInput: false, expected: automationTurn },
    { kind: "thread", personInput: true, expected: personInThreadTurn },
    { kind: "thread", personInput: false, expected: childAgentTurn },
    { kind: "task", personInput: false, expected: childAgentTurn },
  ] as const)(
    "gives a $kind Turn with person input $personInput its behavior",
    ({ kind, personInput, expected }) => {
      expect(turnBehavior({ kind, personInput })).toEqual(expected);
    },
  );

  it("rejects a person's input on a task", () => {
    expect(() => turnBehavior({ kind: "task", personInput: true })).toThrow(
      "A task Conversation cannot have a person's input",
    );
  });

  it("counts only Slack and web input as a person's", () => {
    expect(
      ["slack", "web", "event", "local", undefined].map(isPersonInput),
    ).toEqual([true, true, false, false, false]);
  });
});
