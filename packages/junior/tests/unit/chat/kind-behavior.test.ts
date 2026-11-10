import { describe, expect, it } from "vitest";
import {
  deliversFinalText,
  isPersonInput,
  turnBehavior,
} from "@/chat/conversations/kind-behavior";

const conversationTurn = {
  delivery: "location",
  promptMode: "conversation",
  tools: {
    reviewDesk: true,
    subscriptions: true,
    userCustomization: true,
    reportBlocked: false,
    noReply: true,
    finishAutomationRun: false,
  },
};

const childAgentTurn = {
  delivery: "conversation",
  promptMode: "child_agent",
  tools: {
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
    { kind: "root", personInput: true, expected: conversationTurn },
    { kind: "root", personInput: false, expected: conversationTurn },
    { kind: "thread", personInput: true, expected: conversationTurn },
    { kind: "thread", personInput: false, expected: childAgentTurn },
    { kind: "task", personInput: true, expected: conversationTurn },
    { kind: "task", personInput: false, expected: childAgentTurn },
  ] as const)(
    "gives a $kind Turn with person input $personInput its behavior",
    ({ kind, personInput, expected }) => {
      const behavior = turnBehavior({
        kind,
        personInput,
        automationRun: false,
      });

      expect(behavior).toEqual(expected);
      expect(behavior.answer).toBeUndefined();
    },
  );

  it("makes an Automation run end with its declared result", () => {
    expect(
      turnBehavior({ kind: "root", personInput: false, automationRun: true }),
    ).toEqual({
      delivery: "conversation",
      promptMode: "automation",
      answer: {
        tools: ["finishAutomationRun"],
        reminder: expect.stringContaining("finishAutomationRun"),
        onMissing: "post_nothing",
      },
      tools: {
        ...conversationTurn.tools,
        noReply: false,
        finishAutomationRun: true,
      },
    });
  });

  it("delivers a final response unless the dispatch declares a result or has no outcomes", () => {
    expect(deliversFinalText(undefined)).toBe(true);
    expect(deliversFinalText({ outcomes: [{}] })).toBe(true);
    expect(deliversFinalText({ declaresResult: true })).toBe(false);
    expect(deliversFinalText({ outcomes: [] })).toBe(false);
  });

  it("counts only Slack and web input as a person's", () => {
    expect(
      ["slack", "web", "event", "local", undefined].map(isPersonInput),
    ).toEqual([true, true, false, false, false]);
  });
});
