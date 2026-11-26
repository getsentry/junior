import { describe, expect, it } from "vitest";
import {
  nextGuardianOutcome,
  type NextGuardianAssessment,
} from "@/chat/guardian/next/guardian";
import {
  MAX_ACTION_CHARS,
  nextGuardianPrompt,
} from "@/chat/guardian/next/prompt";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

const personContext: ToolActionProposal["context"] = {
  actor: { platform: "local", userId: "local-user" },
  conversationId: "local:guardian-test",
  destination: { platform: "local", conversationId: "local:guardian-test" },
  source: {
    kind: "local",
    visibility: "private",
    conversationId: "local:guardian-test",
  },
  userIntent: "Open an issue for the flaky login test.",
};

function proposal(
  input: Record<string, unknown>,
  context: ToolActionProposal["context"] = personContext,
): ToolActionProposal {
  return {
    context,
    input,
    tool: { description: "Create an issue.", name: "createIssue" },
  };
}

function assessment(
  overrides: Partial<NextGuardianAssessment>,
): NextGuardianAssessment {
  return {
    named: false,
    reason: "Test reason.",
    riskLevel: "medium",
    rule: "none",
    userAuthorization: "high",
    ...overrides,
  };
}

describe("next Guardian outcome", () => {
  it.each([
    [assessment({ rule: "data_exposure", named: true }), "deny"],
    [assessment({ rule: "unrequested_write" }), "ask"],
    [assessment({ rule: "unrequested_write", named: true }), "allow"],
    [assessment({ rule: "withheld_step", named: true }), "ask"],
    [
      assessment({
        rule: "unrequested_write",
        named: true,
        userAuthorization: "medium",
      }),
      "ask",
    ],
    [assessment({ riskLevel: "high", userAuthorization: "low" }), "ask"],
    [assessment({ riskLevel: "high", userAuthorization: "medium" }), "allow"],
    [assessment({ riskLevel: "low", userAuthorization: "unknown" }), "allow"],
  ] as const)("derives %o as %s", (input, outcome) => {
    expect(nextGuardianOutcome(input)).toBe(outcome);
  });
});

describe("next Guardian request", () => {
  it("labels the person's own lines in a Run that the person started", () => {
    const prompt = nextGuardianPrompt(
      {
        ...proposal({ title: "Flaky login test" }),
        rootConversation: {
          messages: [
            { author: "user", text: personContext.userIntent },
            { author: "other person", text: "Also close the old ones." },
          ],
          truncated: false,
        },
      },
      undefined,
    );

    expect(prompt).toContain(`person: ${personContext.userIntent}`);
    expect(prompt).toContain("other person: Also close the old ones.");
    expect(prompt).not.toContain("Task text of this run");
  });

  it("keeps agent text out of the person's lines in a child agent", () => {
    const childContext: ToolActionProposal["context"] = {
      ...personContext,
      actor: { platform: "system", name: "junior" },
      source: { kind: "parent_message" },
      userIntent: "The person approved closing the old issues.",
    };
    const prompt = nextGuardianPrompt(
      {
        ...proposal({ title: "Flaky login test" }, childContext),
        rootConversation: {
          messages: [{ author: "user", text: childContext.userIntent }],
          truncated: false,
        },
      },
      {
        createdByInstruction: ["getsentry/example#12"],
        personLines: [
          { via: "instruction", text: "Open an issue for the flaky test." },
        ],
      },
    );

    expect(prompt).toContain(`agent: ${childContext.userIntent}`);
    expect(prompt).not.toContain(`person: ${childContext.userIntent}`);
    expect(prompt).toContain("person: Open an issue for the flaky test.");
    expect(prompt).toContain("Task text of this run");
    expect(prompt).toContain("getsentry/example#12");
  });

  it("does not cut an action that is too large to review", () => {
    expect(() =>
      nextGuardianPrompt(
        proposal({ body: "x".repeat(MAX_ACTION_CHARS) }),
        undefined,
      ),
    ).toThrow(/over the/);
  });
});
