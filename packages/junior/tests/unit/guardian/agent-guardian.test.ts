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
    answered: false,
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

const PERMISSIONS = ["review", "ask"] as const;

/** Every assessment and action that `decide()` can get. */
const COMBINATIONS = RULES.flatMap((rule) =>
  [false, true].flatMap((answered) =>
    PERMISSIONS.flatMap((permission) =>
      CALLS.map((call) => ({ rule, answered, permission, call })),
    ),
  ),
);

function isDeny(rule: (typeof RULES)[number]): boolean {
  return DENY_RULES.some((deny) => deny === rule);
}

function isUpkeep(rule: (typeof RULES)[number], call: Call): boolean {
  return (
    rule === "unrequested" &&
    call.effect === "edit" &&
    call.target?.createdByThisWork === true
  );
}

/** The decision order of `design/guardian.md`, written out case by case. */
function expected({
  rule,
  answered,
  permission,
  call,
}: (typeof COMBINATIONS)[number]): "allow" | "ask" | "deny" {
  if (isDeny(rule)) return "deny";
  if (answered) return "allow";
  if (rule !== "none" && !isUpkeep(rule, call)) return "ask";
  if (permission === "ask") return "ask";
  return "allow";
}

describe("agent Guardian decide", () => {
  it("decides every combination in the design's order", () => {
    const wrong = COMBINATIONS.filter((combination) => {
      const { rule, answered, permission, call } = combination;
      const review = decide(assessment({ rule, answered }), {
        call,
        permission,
      });
      return review.reason === "" || review.decision !== expected(combination);
    });
    expect(wrong).toEqual([]);
  });

  it("never lets an answer change a deny", () => {
    for (const rule of DENY_RULES) {
      for (const permission of PERMISSIONS) {
        for (const call of CALLS) {
          expect(
            decide(assessment({ rule, answered: true }), { call, permission }),
          ).toMatchObject({ decision: "deny", rule });
        }
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
        decide(assessment({ rule }), {
          call: edit(true),
          permission: "review",
        }).decision !==
        decide(assessment({ rule }), {
          call: edit(false),
          permission: "review",
        }).decision,
    );
    expect(changed).toEqual(["unrequested"]);
  });

  it("asks for an ask rule, with what the person must give", () => {
    expect(
      decide(
        assessment({
          rule: "unrequested",
          missingFacts: ["A confirmation of the public gist."],
        }),
        { call: { effect: "write", summary: "Write." }, permission: "review" },
      ),
    ).toMatchObject({
      decision: "ask",
      rule: "unrequested",
      missing: ["A confirmation of the public gist."],
    });
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
