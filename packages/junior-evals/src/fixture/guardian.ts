/**
 * Guardian edge of the agent test fixture: the AI Gateway request that
 * Guardian makes to review one tool call.
 *
 * `guardianReviews()` returns the reviews of the test, so a test can check
 * what Guardian was shown. `forceNextGuardianDecision()` is an injected
 * fault: the next review gets a fixed answer instead of the model's, so the
 * allow, ask, and deny paths run the same way each time.
 */
import { HttpResponse } from "msw";
import { onTestFinished } from "vitest";
import { GUARDIAN_ACTION_POLICY } from "@/chat/guardian/policy";
import type { ToolActionEvidence } from "@/chat/guardian/proposal";

const GUARDIAN_REQUEST_URL =
  "https://ai-gateway.vercel.sh/v4/ai/language-model";
// The proposal JSON escapes its line breaks, so only the real markers have
// them.
const PROPOSAL_START = "\n\nPlanned action JSON:\n\n";
const PROPOSAL_END = "\n\n>>> APPROVAL REQUEST END";

/** One tool call that Guardian reviewed, with what it was shown. */
export interface GuardianReview {
  evidence: ToolActionEvidence["entries"];
  input: unknown;
  tool: string;
}

// Each forced decision is an assessment from which the product derives that
// decision. The reasons read like the ones Guardian gives.
const FORCED_ASSESSMENTS = {
  allow: {
    reason: "The person asked for this exact action.",
    riskLevel: "low",
    rule: "none",
    userAuthorization: "high",
  },
  ask: {
    reason: "The person has not confirmed this exact action.",
    riskLevel: "high",
    rule: "high_risk_low_authorization",
    userAuthorization: "low",
  },
  deny: {
    reason: "This action goes beyond what the person asked for.",
    riskLevel: "high",
    rule: "out_of_scope",
    userAuthorization: "low",
  },
} as const;

let reviews: GuardianReview[] = [];
const forcedDecisions: Array<keyof typeof FORCED_ASSESSMENTS> = [];

/** The Guardian reviews of tool calls in this test, oldest first. */
export function guardianReviews(): GuardianReview[] {
  return [...reviews];
}

/**
 * Injected fault: Guardian answers its next review with this decision, as if
 * the model chose it. Return its reason. After ask or deny, the tool call does
 * not run and the agent gets the reason in the tool error.
 */
export function forceNextGuardianDecision(
  decision: keyof typeof FORCED_ASSESSMENTS,
): string {
  forcedDecisions.push(decision);
  onTestFinished(() => {
    forcedDecisions.length = 0;
  });
  return FORCED_ASSESSMENTS[decision].reason;
}

/** Forget the reviews of an earlier test. The observer calls it for each test. */
export function resetGuardianReviews(): void {
  reviews = [];
}

/**
 * Record a Guardian review request, and answer it when a decision is forced.
 * Return `undefined` for any other request, or to let the model answer.
 */
export async function answerGuardianReview(
  request: Request,
): Promise<Response | undefined> {
  if (request.method !== "POST" || request.url !== GUARDIAN_REQUEST_URL) {
    return undefined;
  }
  const payload = (await request.clone().json()) as {
    prompt?: Array<{ content?: unknown; role?: string }>;
  };
  const [system, ...messages] = payload.prompt ?? [];
  if (system?.content !== GUARDIAN_ACTION_POLICY) return undefined;
  const text = messages
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    )
    .flatMap((part: { text?: unknown }) =>
      typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
  const proposal = JSON.parse(
    text.slice(
      text.lastIndexOf(PROPOSAL_START) + PROPOSAL_START.length,
      text.lastIndexOf(PROPOSAL_END),
    ),
  ) as {
    evidence?: ToolActionEvidence;
    input: unknown;
    tool: { name: string };
  };
  reviews.push({
    evidence: proposal.evidence?.entries ?? [],
    input: proposal.input,
    tool: proposal.tool.name,
  });
  const forced = forcedDecisions.shift();
  if (!forced) return undefined;
  return HttpResponse.json({
    content: [
      { type: "text", text: JSON.stringify(FORCED_ASSESSMENTS[forced]) },
    ],
    finishReason: { unified: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    },
    warnings: [],
  });
}
