import { describe, expect, it } from "vitest";
import {
  agentGuardianDecision,
  type AgentGuardianAssessment,
} from "@/chat/guardian/agent/guardian";
import { renderAction, renderMessages } from "@/chat/guardian/agent/render";

function assessment(
  overrides: Partial<AgentGuardianAssessment>,
): AgentGuardianAssessment {
  return {
    rule: "none",
    reason: "Requested work.",
    missingFacts: [],
    ...overrides,
  };
}

const write = { call: { effect: "write", summary: "Write." } } as const;

function upkeep(createdByThisWork: boolean) {
  return {
    call: {
      effect: "upkeep",
      target: {
        ref: "getsentry/junior#691",
        audience: "world",
        createdByThisWork,
      },
      summary: "Update pull request getsentry/junior#691.",
    },
  } as const;
}

describe("agent Guardian decision", () => {
  it("allows an action that matches no rule", () => {
    expect(agentGuardianDecision(assessment({}), write)).toEqual({
      decision: "allow",
      reason: "Requested work.",
    });
  });

  it("asks for an ask rule, with what the person must give", () => {
    expect(
      agentGuardianDecision(
        assessment({
          rule: "unrequested",
          missingFacts: ["A confirmation of the public gist."],
        }),
        write,
      ),
    ).toMatchObject({
      decision: "ask",
      rule: "unrequested",
      missing: ["A confirmation of the public gist."],
    });
  });

  it("denies a deny rule, also with missing facts", () => {
    expect(
      agentGuardianDecision(
        assessment({ rule: "data_exposure", missingFacts: ["Approval."] }),
        write,
      ),
    ).toEqual({
      decision: "deny",
      rule: "data_exposure",
      reason: "Requested work.",
    });
  });

  it("allows unrequested upkeep of a target that this work created", () => {
    expect(
      agentGuardianDecision(assessment({ rule: "unrequested" }), upkeep(true)),
    ).toMatchObject({ decision: "allow" });
  });

  it("asks for upkeep of a target that this work did not create", () => {
    expect(
      agentGuardianDecision(assessment({ rule: "unrequested" }), upkeep(false)),
    ).toMatchObject({ decision: "ask", rule: "unrequested" });
  });

  it("never clears another rule for upkeep", () => {
    expect(
      agentGuardianDecision(
        assessment({ rule: "internal_disclosure" }),
        upkeep(true),
      ),
    ).toMatchObject({ decision: "ask", rule: "internal_disclosure" });
  });
});

describe("agent Guardian prompt", () => {
  it("marks each message with its author, oldest first", () => {
    const text = renderMessages([
      { from: "instruction", text: "Publish the report." },
      { from: "context", text: "Should I post it?" },
      { from: "person", text: "also email it" },
    ]);

    expect(text.indexOf("[instruction] Publish the report.")).toBeLessThan(
      text.indexOf("[context] Should I post it?"),
    );
    expect(text).toContain("[person] also email it");
  });

  it("shows the facts of the call with the exact input", () => {
    const text = renderAction({
      tool: "createGist",
      call: {
        effect: "write",
        summary: "Create a gist.",
        target: {
          ref: "gist-1",
          audience: "world",
          createdByThisWork: false,
        },
      },
      input: { content: "report" },
      permission: "review",
    });

    expect(text).toContain('"audience":"world"');
    expect(text).toContain('"content":"report"');
  });
});
