import { describe, expect, it } from "vitest";
import { proposalActionHash } from "@/chat/guardian/authority";
import {
  applyGrant,
  proposalGrant,
  type GrantRuleKind,
} from "@/chat/guardian/grants";
import type { GuardianActionResult } from "@/chat/guardian/guardian";
import type {
  ToolActionDecision,
  ToolActionProposal,
} from "@/chat/guardian/proposal";

function proposal(input: Record<string, unknown>): ToolActionProposal {
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
      userIntent: "Fix the CSV export.",
    },
    input,
    tool: { description: "Update a pull request.", name: "updatePullRequest" },
  };
}

function reviewed(
  outcome: ToolActionDecision,
  rule: string,
): GuardianActionResult {
  return {
    decidedBy: "guardian",
    decision: {
      decision: outcome,
      reason: "The rule matched.",
      riskLevel: "medium",
      rule,
      userAuthorization: "medium",
    },
    outcome,
  };
}

const RULE_KINDS: Record<string, GrantRuleKind> = {
  data_exposure: "hard",
  different_change: "confirmation",
  withheld_step: "hold",
};
const ruleKind = (rule: string | undefined) =>
  RULE_KINDS[rule ?? ""] ?? "confirmation";

describe("grants", () => {
  it("finds the grant of the exact action only", () => {
    const granted = proposal({ pull_request: 930, body: "New body" });
    const authority = {
      confirmations: [],
      created: [],
      grants: [
        { actionHash: proposalActionHash(granted), grant: "own-pr-upkeep" },
      ],
      lines: [],
    };

    expect(proposalGrant(authority, granted)).toBe("own-pr-upkeep");
    expect(
      proposalGrant(
        authority,
        proposal({ pull_request: 930, state: "closed" }),
      ),
    ).toBeUndefined();
    expect(proposalGrant(undefined, granted)).toBeUndefined();
  });

  it("turns a confirmation rule into an allow and records the grant", () => {
    const result = applyGrant(
      reviewed("ask", "different_change"),
      "own-pr-upkeep",
      ruleKind,
    );

    expect(result).toMatchObject({
      decision: { decision: "allow", grant: "own-pr-upkeep" },
      outcome: "allow",
    });
  });

  it("keeps a hard rule, a hold, and an action with no grant", () => {
    const hard = reviewed("deny", "data_exposure");
    const hold = reviewed("ask", "withheld_step");
    const ungranted = reviewed("ask", "different_change");

    expect(applyGrant(hard, "own-pr-upkeep", ruleKind)).toBe(hard);
    expect(applyGrant(hold, "own-pr-upkeep", ruleKind)).toBe(hold);
    expect(applyGrant(ungranted, undefined, ruleKind)).toBe(ungranted);
  });

  it("does not change a review that could not run", () => {
    const unavailable: GuardianActionResult = {
      error: new Error("review failed"),
      outcome: "unavailable",
    };

    expect(applyGrant(unavailable, "own-pr-upkeep", ruleKind)).toBe(
      unavailable,
    );
  });
});
