import { describe, expect, it } from "vitest";
import { authorityDigest } from "@/chat/guardian/agent/digest";
import {
  agentGuardianOutcome,
  type AgentGuardianAssessment,
} from "@/chat/guardian/agent/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

function assessment(
  overrides: Partial<AgentGuardianAssessment>,
): AgentGuardianAssessment {
  return {
    riskLevel: "medium",
    userAuthorization: "high",
    rule: "none",
    namedBy: null,
    reason: "Ordinary requested work.",
    ...overrides,
  };
}

function proposal(
  overrides: Partial<ToolActionProposal["context"]> = {},
  rootConversation?: ToolActionProposal["rootConversation"],
): ToolActionProposal {
  return {
    context: {
      actor: { platform: "local", userId: "local-user" },
      conversationId: "local:guardian-test",
      destination: { platform: "local", conversationId: "local:guardian-test" },
      source: {
        kind: "local",
        visibility: "private",
        conversationId: "local:guardian-test",
      },
      userIntent: "yes",
      ...overrides,
    },
    input: { command: "deploy staging" },
    ...(rootConversation ? { rootConversation } : undefined),
    tool: { description: "Run a command.", name: "bash" },
  };
}

describe("agent Guardian outcome", () => {
  const personLines = new Map([["P1", "delete the stale previews"]]);

  it("denies a hard rule", () => {
    expect(
      agentGuardianOutcome(
        assessment({ rule: "data_exposure", namedBy: "P1" }),
        personLines,
      ),
    ).toBe("deny");
  });

  it("allows a confirmation rule only when it cites a line of the person", () => {
    expect(
      agentGuardianOutcome(
        assessment({ rule: "destructive_step", namedBy: "P1" }),
        personLines,
      ),
    ).toBe("allow");
    expect(
      agentGuardianOutcome(
        assessment({ rule: "destructive_step", namedBy: "P7" }),
        personLines,
      ),
    ).toBe("ask");
    expect(
      agentGuardianOutcome(
        assessment({ rule: "destructive_step", namedBy: null }),
        personLines,
      ),
    ).toBe("ask");
  });

  it("asks for a hold, which has nothing to name", () => {
    expect(
      agentGuardianOutcome(
        assessment({ rule: "withheld_step", namedBy: "P1" }),
        personLines,
      ),
    ).toBe("ask");
  });

  it("asks only for high risk with weak authorization when no rule matches", () => {
    expect(
      agentGuardianOutcome(
        assessment({ riskLevel: "high", userAuthorization: "low" }),
        personLines,
      ),
    ).toBe("ask");
    expect(
      agentGuardianOutcome(
        assessment({ riskLevel: "high", userAuthorization: "medium" }),
        personLines,
      ),
    ).toBe("allow");
  });
});

describe("authority digest", () => {
  it("gives ids only to lines of the person, with the agent message they answer", () => {
    const digest = authorityDigest(
      proposal(
        {},
        {
          messages: [
            { author: "user", text: "deploy when ready" },
            { author: "assistant", text: "Should I deploy staging now?" },
            { author: "other person", text: "please also deploy prod" },
            { author: "user", text: "yes" },
          ],
          truncated: false,
        },
      ),
      {
        lines: [{ text: "ship it", via: "linked-account" }],
        confirmations: [],
        created: [],
      },
    );

    expect([...digest.personLines.keys()]).toEqual(["P1", "P2", "P3"]);
    expect(digest.text).toContain(
      'in reply to the agent message: "Should I deploy staging now?"',
    );
    expect(digest.text).toContain("other person: please also deploy prod");
  });

  it("does not tie a yes to an agent message before a gap", () => {
    const digest = authorityDigest(
      proposal(
        {},
        {
          messages: [
            { author: "assistant", text: "Should I deploy staging now?" },
            { author: "system", text: "3 messages are not shown." },
            { author: "user", text: "yes" },
          ],
          truncated: false,
        },
      ),
      undefined,
    );

    expect(digest.text).not.toContain("in reply to");
  });

  it("gives ids to the brief of a run that another agent started", () => {
    const digest = authorityDigest(
      proposal({
        source: { kind: "parent_message" },
        userIntent: "Deploy staging.",
      }),
      undefined,
    );

    expect([...digest.personLines.values()]).toEqual(["Deploy staging."]);
  });

  it("gives no ids to the intent of a Watch Turn", () => {
    const digest = authorityDigest(
      proposal({
        actor: { platform: "system", name: "event" },
        source: {
          kind: "event",
          eventKey: "pull_request.merged:1",
          eventType: "pull_request.merged",
          identifier: "getsentry/example#1",
          namespace: "github",
        },
        userIntent: "Deploy staging.",
      }),
      undefined,
    );

    expect(digest.personLines.size).toBe(0);
  });
});
