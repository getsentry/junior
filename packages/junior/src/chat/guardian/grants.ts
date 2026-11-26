/**
 * Guardian grants (`grants` in `design/guardian.md`).
 *
 * A tool's code checks stored facts and names a grant before Guardian
 * decides. The gate records it in the authority record by action hash, and
 * a Guardian that applies grants still reviews the action, with the grant
 * as a fact. Code then derives the outcome: a grant turns a confirmation
 * rule into an allow, and nothing else (`grant-narrows`, `grant-limits`).
 */
import {
  proposalActionHash,
  type AuthorityRecord,
} from "@/chat/guardian/authority";
import type { GuardianActionResult } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

/**
 * What a rule of one Guardian's policy is, for a granted action.
 *
 * - `hard`: a hard rule. It still denies.
 * - `hold`: a hold or a restriction from a person. It still asks.
 * - `confirmation`: any other rule that asks, also high risk with weak
 *   authorization. The grant answers it, so the action runs.
 */
export type GrantRuleKind = "hard" | "hold" | "confirmation";

/** The grant that core recorded for the action of one proposal, if any. */
export function proposalGrant(
  authority: AuthorityRecord | undefined,
  proposal: ToolActionProposal,
): string | undefined {
  if (!authority || authority.grants.length === 0) return undefined;
  const hash = proposalActionHash(proposal);
  return authority.grants.find((grant) => grant.actionHash === hash)?.grant;
}

/**
 * Apply a grant to one reviewed action. Only an ask or a deny from a
 * confirmation rule becomes an allow, and the decision records the grant
 * (`grant-recorded`). Every other result stays as it is.
 */
export function applyGrant(
  result: GuardianActionResult,
  grant: string | undefined,
  ruleKind: (rule: string | undefined) => GrantRuleKind,
): GuardianActionResult {
  if (
    !grant ||
    !("decision" in result) ||
    result.outcome === "allow" ||
    ruleKind(result.decision.rule) !== "confirmation"
  ) {
    return result;
  }
  return {
    decidedBy: "guardian",
    decision: {
      ...result.decision,
      decision: "allow",
      grant,
      reason: `Grant ${grant} applies, so this rule does not block: ${result.decision.reason}`,
    },
    outcome: "allow",
  };
}
