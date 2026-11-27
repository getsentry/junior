import { describe, expect, it } from "vitest";
import {
  decide,
  type AgentGuardianAssessment,
} from "@/chat/guardian/agent/guardian";
import { ASK_RULES, DENY_RULES } from "@/chat/guardian/agent/policy";
import type { Call, Target } from "@/chat/guardian/guardian";
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

const RULES = ["none", ...ASK_RULES, ...DENY_RULES] as const;

const TARGETS = [
  undefined,
  { ref: "getsentry/junior#691", audience: "world", createdByThisWork: true },
  { ref: "getsentry/junior#691", audience: "world", createdByThisWork: false },
] as const satisfies readonly (Target | undefined)[];

/** Every call shape that core can give Guardian. */
const CALLS: Call[] = [
  ...(["read", "edit", "write"] as const).flatMap((effect) =>
    TARGETS.map((target): Call => ({
      effect,
      summary: `${effect} call`,
      ...(target ? { target } : undefined),
    })),
  ),
  ...TARGETS.map((target): Call => ({
    effect: "command",
    summary: "git push",
    repos: target ? [{ path: "/vercel/sandbox/repos/junior", target }] : [],
    placeholders: [],
  })),
];

describe("agent Guardian decide", () => {
  it("returns a decision for every rule and call", () => {
    for (const rule of RULES) {
      for (const call of CALLS) {
        const review = decide(assessment({ rule }), { call });
        expect(["allow", "ask", "deny"]).toContain(review.decision);
        expect(review.reason).not.toBe("");
      }
    }
  });

  it("denies every hard rule, whatever the call", () => {
    for (const rule of DENY_RULES) {
      for (const call of CALLS) {
        expect(decide(assessment({ rule }), { call })).toMatchObject({
          decision: "deny",
          rule,
        });
      }
    }
  });

  it("lets an edit of a target this work created change only `unrequested`", () => {
    const edit = (createdByThisWork: boolean): Call => ({
      effect: "edit",
      summary: "Update pull request getsentry/junior#691.",
      target: {
        ref: "getsentry/junior#691",
        audience: "world",
        createdByThisWork,
      },
    });
    const changed = RULES.filter(
      (rule) =>
        decide(assessment({ rule }), { call: edit(true) }).decision !==
        decide(assessment({ rule }), { call: edit(false) }).decision,
    );
    expect(changed).toEqual(["unrequested"]);
    expect(
      decide(assessment({ rule: "unrequested" }), { call: edit(true) }),
    ).toMatchObject({
      decision: "allow",
      reason: expect.stringMatching(/^Upkeep/),
    });
  });

  it("asks for an ask rule, with what the person must give", () => {
    expect(
      decide(
        assessment({
          rule: "unrequested",
          missingFacts: ["A confirmation of the public gist."],
        }),
        { call: { effect: "write", summary: "Write." } },
      ),
    ).toMatchObject({
      decision: "ask",
      rule: "unrequested",
      missing: ["A confirmation of the public gist."],
    });
  });

  it("allows an action that matches no rule", () => {
    for (const call of CALLS) {
      expect(decide(assessment({}), { call }).decision).toBe("allow");
    }
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
