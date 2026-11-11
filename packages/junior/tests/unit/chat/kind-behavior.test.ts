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
    submitWalkthrough: false,
    walkthroughQuestions: false,
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
    submitWalkthrough: false,
    walkthroughQuestions: false,
  },
};

describe("turnBehavior", () => {
  it.each([
    { kind: "root", personInput: true, expected: rootTurn },
    { kind: "root", personInput: false, expected: rootTurn },
    // A person's reply in the run's thread, and an Event Turn.
    { kind: "automation", personInput: true, expected: rootTurn },
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

  // `root` is a run that started before kind `automation` was stored.
  it.each(["automation", "root"] as const)(
    "makes an Automation run on a $0 Conversation end with its declared result",
    (kind) => {
      expect(
        turnBehavior({ kind, personInput: false, automationRun: true }),
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
    },
  );

  it("gives a Walkthrough generation the submit tool, tight limits, and nothing that reaches people", () => {
    expect(
      turnBehavior({
        kind: "root",
        personInput: false,
        automationRun: false,
        walkthroughGeneration: true,
      }),
    ).toEqual({
      delivery: "conversation",
      promptMode: "conversation",
      gated: false,
      tools: {
        agents: "none",
        reviewDesk: false,
        subscriptions: false,
        userCustomization: false,
        reportBlocked: false,
        noReply: false,
        finishAutomationRun: false,
        submitWalkthrough: true,
        walkthroughQuestions: false,
      },
      limits: { maxToolCalls: 80, maxCostUsd: 5 },
    });
  });

  it("gives a Walkthrough question the read tools and a reply, and nothing that reaches people", () => {
    expect(
      turnBehavior({
        kind: "root",
        personInput: true,
        automationRun: false,
        walkthroughQuestions: true,
      }),
    ).toEqual({
      delivery: "location",
      promptMode: "conversation",
      gated: false,
      tools: {
        agents: "none",
        reviewDesk: false,
        subscriptions: false,
        userCustomization: false,
        reportBlocked: false,
        noReply: false,
        finishAutomationRun: false,
        submitWalkthrough: false,
        walkthroughQuestions: true,
      },
      limits: { maxToolCalls: 20, maxCostUsd: 1 },
    });
  });

  it("counts only Slack and web input as a person's", () => {
    expect(
      ["slack", "web", "event", "local", undefined].map(isPersonInput),
    ).toEqual([true, true, false, false, false]);
  });
});
