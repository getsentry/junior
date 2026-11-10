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
    reportBlocked: false,
    noReply: true,
    finishAutomationRun: false,
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
    reportBlocked: true,
    noReply: true,
    finishAutomationRun: false,
  },
};

describe("turnBehavior", () => {
  it.each([
    { kind: "root", personInput: true, expected: rootTurn },
    { kind: "root", personInput: false, expected: rootTurn },
    { kind: "automation", personInput: false, expected: rootTurn },
    { kind: "thread", personInput: true, expected: personInThreadTurn },
    { kind: "thread", personInput: false, expected: childAgentTurn },
    { kind: "task", personInput: false, expected: childAgentTurn },
  ] as const)(
    "gives a $kind Turn with person input $personInput its behavior",
    ({ kind, personInput, expected }) => {
      expect(turnBehavior({ kind, personInput, automationRun: false })).toEqual(
        expected,
      );
    },
  );

  it("rejects a person's input on a task", () => {
    expect(() =>
      turnBehavior({ kind: "task", personInput: true, automationRun: false }),
    ).toThrow("A task Conversation cannot have a person's input");
  });

  it("makes an Automation run end with its declared result", () => {
    expect(
      turnBehavior({ kind: "root", personInput: false, automationRun: true }),
    ).toEqual({
      delivery: "conversation",
      promptMode: "automation",
      gated: true,
      tools: {
        ...rootTurn.tools,
        noReply: false,
        finishAutomationRun: true,
      },
    });
  });

  it("counts only Slack and web input as a person's", () => {
    expect(
      ["slack", "web", "event", "local", undefined].map(isPersonInput),
    ).toEqual([true, true, false, false, false]);
  });
});
