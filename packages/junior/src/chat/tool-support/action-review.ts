/**
 * Owns the execution gate for reviewable tool actions.
 *
 * Deterministic host checks establish authority before the model evaluates
 * untrusted action evidence.
 */
import type {
  Destination,
  Source,
  ToolAnnotations,
} from "@sentry/junior-plugin-api";
import { createHash } from "node:crypto";
import type { Actor } from "@/chat/actor";
import type { CredentialContext } from "@/chat/credentials/context";
import type {
  AnyToolDefinition,
  ToolApprovalResolution,
} from "@/chat/tools/definition";
import type {
  ToolActionPriorRejection,
  ToolActionRejectionMarker,
} from "@/chat/tool-support/action-review-history";

/** Outcome available to the action reviewer. */
export type ToolActionDecision = "allow" | "ask" | "deny";

export interface ToolActionReviewDecision {
  decision: ToolActionDecision;
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  userAuthorization: "high" | "medium" | "low" | "unknown";
}

export interface ToolActionEvidence {
  entries: Array<{
    role: "assistant" | "user";
    text: string;
  }>;
  omittedEntries: number;
}

export interface ToolActionRejection {
  decision: Exclude<ToolActionDecision, "allow">;
  key: string;
  reason: string;
  reviewedAction?: ToolActionPriorRejection;
  riskLevel?: ToolActionReviewDecision["riskLevel"];
  userAuthorization?: ToolActionReviewDecision["userAuthorization"];
}

/** Exact model-review request; only core-supplied context carries authority. */
export interface ToolActionProposal {
  context: {
    actor:
      | { platform: "local"; userId: string }
      | { platform: "slack"; teamId: string; userId: string }
      | { platform: "system"; name: string };
    conversationId: string;
    credential?: {
      actor:
        | { type: "user"; userId: string }
        | { platform: "system"; name: string };
      subject?: {
        allowedWhen: "private-direct-conversation" | "scheduled-task";
        taskId?: string;
        type: "user";
        userId: string;
      };
    };
    destination: Destination;
    source: Source;
    userIntent: string;
  };
  evidence?: ToolActionEvidence;
  input: Record<string, unknown>;
  priorRejectedActions?: ToolActionPriorRejection[];
  tool: {
    annotations?: ToolAnnotations;
    description: string;
    dispatcherName?: string;
    identity?: {
      id: string;
      name: string;
      plugin: string;
    };
    name: string;
    proposalDescription?: string;
    catalogSource?: {
      description: string;
      id: string;
    };
  };
}

/** Schema-constrained model capability for one action proposal. */
export interface ToolActionReviewer {
  review(
    proposal: ToolActionProposal,
    options?: { signal?: AbortSignal },
  ): Promise<ToolActionReviewDecision>;
}

/** Core-owned context and reviewer used by the tool execution gate. */
export interface ToolActionReview {
  context: {
    actor?: Actor;
    conversationId?: string;
    credentialContext?: CredentialContext;
    destination: Destination;
    source: Source;
    userIntent?: () => string;
    evidence?: () => ToolActionEvidence;
  };
  /** Bounded core-owned rejection context for this run slice. */
  priorRejections: ToolActionPriorRejection[];
  /** Compact exact rejection keys retained for the full run slice. */
  rejectedActions: ToolActionRejection[];
  /** Core-owned results awaiting Pi's durable tool-result hook. */
  pendingRejections: Map<string, ToolActionRejectionMarker>;
  /** Escalate unexpected reviewer failures to the owning agent-run boundary. */
  onUnavailable(error: ToolActionReviewUnavailableError): void;
  reviewer: ToolActionReviewer;
}

const ACTION_CONFIRMATION_INSTRUCTIONS = [
  "The action was not executed because explicit user confirmation is required.",
  "Stop tool use for this turn and respond to the user now with a direct, concise confirmation question that names the exact action, target, and material side effects.",
  "Do not mention Guardian, the runtime, policy, or internal review mechanics.",
  "Do not call another tool or retry until the user explicitly confirms this exact action.",
].join("\n");

const ACTION_DENIAL_INSTRUCTIONS = [
  "This action was rejected due to unacceptable risk.",
  "The agent must not attempt the same outcome through a workaround, indirect execution, or policy circumvention.",
  "If the reason is missing or withheld authorization and exact confirmation could make the action allowable, stop tool use for this turn and respond to the user now with a direct, concise confirmation question that names the exact action, target, and material side effects.",
  "Proceed only with a materially safer alternative. Otherwise, stop and explain the specific risk to the user without mentioning Guardian or internal review mechanics.",
].join("\n");

/** Expected tool failure when core or Guardian rejects an exact action. */
export class ToolActionRejectedError extends Error {
  readonly decision: Exclude<ToolActionDecision, "allow">;
  readonly reason: string;
  readonly reviewedAction?: ToolActionPriorRejection;
  readonly riskLevel?: ToolActionReviewDecision["riskLevel"];
  readonly userAuthorization?: ToolActionReviewDecision["userAuthorization"];

  constructor(
    decision: Exclude<ToolActionDecision, "allow">,
    reason: string,
    assessment: Partial<
      Pick<ToolActionReviewDecision, "riskLevel" | "userAuthorization">
    > & { reviewedAction?: ToolActionPriorRejection } = {},
  ) {
    super(
      decision === "ask"
        ? `${ACTION_CONFIRMATION_INSTRUCTIONS}\nReason: ${reason}`
        : `${ACTION_DENIAL_INSTRUCTIONS}\nReason: ${reason}`,
    );
    this.name = "ToolActionRejectedError";
    this.decision = decision;
    this.reason = reason;
    this.reviewedAction = assessment.reviewedAction;
    this.riskLevel = assessment.riskLevel;
    this.userAuthorization = assessment.userAuthorization;
  }
}

/** Required review could not run, so the action was not executed. */
export class ToolActionReviewUnavailableError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "Required action review is unavailable; the action was not executed.",
      {
        cause: options?.cause,
      },
    );
    this.name = "ToolActionReviewUnavailableError";
  }
}

/** Keep tools outside action review unless they explicitly opt in. */
function effectiveApprovalMode(
  tool: AnyToolDefinition,
  resolved: ToolApprovalResolution | undefined,
): "approve" | "review" {
  const declared = tool.approvalMode;
  if (declared === undefined || declared === "approve") {
    return "approve";
  }
  if (declared === "review") {
    return "review";
  }
  if (declared !== "auto") {
    return "review";
  }

  const annotations = resolved?.annotations ?? tool.annotations;
  if (
    annotations?.destructiveHint === true ||
    annotations?.openWorldHint === true ||
    annotations?.readOnlyHint === false
  ) {
    return "review";
  }
  if (tool.identity || resolved?.source || tool.source) {
    return "review";
  }
  return "approve";
}

function actionActor(actor: Actor): ToolActionProposal["context"]["actor"] {
  if (actor.platform === "system") {
    return { platform: "system", name: actor.name };
  }
  if (actor.platform === "slack") {
    return {
      platform: "slack",
      teamId: actor.teamId,
      userId: actor.userId,
    };
  }
  return { platform: "local", userId: actor.userId };
}

function actionCredential(
  credentialContext: CredentialContext | undefined,
): ToolActionProposal["context"]["credential"] {
  if (!credentialContext) {
    return undefined;
  }
  const actor =
    "type" in credentialContext.actor
      ? {
          type: "user" as const,
          userId: credentialContext.actor.userId,
        }
      : {
          platform: "system" as const,
          name: credentialContext.actor.name,
        };
  const subject =
    "subject" in credentialContext && credentialContext.subject
      ? {
          allowedWhen: credentialContext.subject.allowedWhen,
          ...(credentialContext.subject.allowedWhen === "scheduled-task"
            ? { taskId: credentialContext.subject.taskId }
            : {}),
          type: credentialContext.subject.type,
          userId: credentialContext.subject.userId,
        }
      : undefined;
  return {
    actor,
    ...(subject ? { subject } : {}),
  };
}

function assertAuthoritativeContext(
  context: ToolActionReview["context"],
): asserts context is ToolActionReview["context"] & {
  actor: Actor;
  conversationId: string;
  userIntent: () => string;
} {
  if (!context.conversationId?.trim()) {
    throw new ToolActionReviewUnavailableError();
  }
  if (!context.actor) {
    throw new ToolActionReviewUnavailableError();
  }
  if (!context.userIntent?.().trim()) {
    throw new ToolActionReviewUnavailableError();
  }

  const credentialActor = context.credentialContext?.actor;
  if (!credentialActor) {
    return;
  }
  if ("type" in credentialActor) {
    if (
      !("userId" in context.actor) ||
      credentialActor.userId !== context.actor.userId
    ) {
      throw new ToolActionReviewUnavailableError();
    }
    return;
  }
  if (
    context.actor.platform !== "system" ||
    context.actor.name !== credentialActor.name
  ) {
    throw new ToolActionReviewUnavailableError();
  }
}

/** Build the bounded wire proposal without treating tool metadata as authority. */
function buildProposal(
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  resolved: ToolApprovalResolution | undefined,
  context: ToolActionReview["context"] & {
    actor: Actor;
    conversationId: string;
    userIntent: () => string;
  },
  priorRejections: ToolActionPriorRejection[],
): ToolActionProposal {
  const name = resolved?.name ?? toolName;
  const proposalDescription = tool.describeProposal?.(input);
  const credential = actionCredential(context.credentialContext);
  return {
    context: {
      actor: actionActor(context.actor),
      conversationId: context.conversationId,
      ...(credential ? { credential } : {}),
      destination: context.destination,
      source: context.source,
      userIntent: context.userIntent(),
    },
    ...(context.evidence ? { evidence: context.evidence() } : {}),
    input,
    ...(priorRejections.length > 0
      ? {
          priorRejectedActions: priorRejections.map((rejection) => ({
            ...rejection,
          })),
        }
      : {}),
    tool: {
      ...((resolved?.annotations ?? tool.annotations)
        ? { annotations: resolved?.annotations ?? tool.annotations }
        : {}),
      description: resolved?.description ?? tool.description,
      ...(name !== toolName ? { dispatcherName: toolName } : {}),
      ...(tool.identity ? { identity: tool.identity } : {}),
      name,
      ...(proposalDescription ? { proposalDescription } : {}),
      ...((resolved?.source ?? tool.source)
        ? { catalogSource: resolved?.source ?? tool.source }
        : {}),
    },
  };
}

const MAX_VISIBLE_DENIAL_CHARS = 12_000;
const MAX_VISIBLE_DENIAL_INPUT_CHARS = 4_000;

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

/** Build the compact key used to reject an exact repeated tool action. */
export function toolActionKey(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  try {
    const canonical = JSON.stringify(
      canonicalJson({
        input,
        toolName,
      }),
    );
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return undefined;
  }
}

/** Bind an exact rejection to one bounded authoritative-intent epoch. */
export function toolActionRejectionKey(
  decision: Exclude<ToolActionDecision, "allow">,
  userIntent: string,
  actionKey: string,
): string {
  const intentKey = createHash("sha256").update(userIntent).digest("hex");
  return `${decision}:${intentKey}:${actionKey}`;
}

function rejectionKey(
  toolName: string,
  input: Record<string, unknown>,
  userIntent: string,
  decision: Exclude<ToolActionDecision, "allow">,
): string | undefined {
  const action = toolActionKey(toolName, input);
  if (!action) {
    return undefined;
  }
  return toolActionRejectionKey(decision, userIntent, action);
}

function projectedRejection(
  proposal: ToolActionProposal,
  decision: ToolActionReviewDecision,
): ToolActionPriorRejection {
  const inputJson = JSON.stringify(canonicalJson(proposal.input));
  const input =
    inputJson.length <= MAX_VISIBLE_DENIAL_INPUT_CHARS
      ? proposal.input
      : {
          summary: `${inputJson.slice(
            0,
            MAX_VISIBLE_DENIAL_INPUT_CHARS / 2,
          )}\n[truncated]\n${inputJson.slice(
            -MAX_VISIBLE_DENIAL_INPUT_CHARS / 2,
          )}`,
        };
  return {
    decision: decision.decision as Exclude<ToolActionDecision, "allow">,
    input,
    reason: decision.reason,
    riskLevel: decision.riskLevel,
    tool: proposal.tool,
    userAuthorization: decision.userAuthorization,
  };
}

function appendVisibleRejection(
  rejections: ToolActionPriorRejection[],
  rejection: ToolActionPriorRejection,
): void {
  rejections.push(rejection);
  while (
    rejections.length > 0 &&
    JSON.stringify(rejections).length > MAX_VISIBLE_DENIAL_CHARS
  ) {
    rejections.shift();
  }
}

/** Review a validated tool action immediately before execution when required. */
export async function reviewToolAction(
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  review: ToolActionReview | undefined,
  signal?: AbortSignal,
): Promise<ToolActionReviewDecision | undefined> {
  if (tool.approvalMode === undefined || tool.approvalMode === "approve") {
    return;
  }
  let proposal: ToolActionProposal;
  let decision: ToolActionReviewDecision;
  try {
    const resolved = tool.resolveApprovalMetadata?.(input);
    if (effectiveApprovalMode(tool, resolved) === "approve") {
      return;
    }
    if (!review) {
      throw new ToolActionReviewUnavailableError();
    }

    assertAuthoritativeContext(review.context);
    proposal = buildProposal(
      toolName,
      tool,
      input,
      resolved,
      review.context,
      review.priorRejections,
    );
    const denialKey = rejectionKey(
      toolName,
      input,
      proposal.context.userIntent,
      "deny",
    );
    const askKey = rejectionKey(
      toolName,
      input,
      proposal.context.userIntent,
      "ask",
    );
    const priorRejection = review.rejectedActions.find(
      (rejection) => rejection.key === denialKey || rejection.key === askKey,
    );
    if (priorRejection) {
      throw new ToolActionRejectedError(
        priorRejection.decision,
        `This exact action was already rejected under the current user instruction: ${priorRejection.reason}`,
        {
          ...priorRejection,
          reviewedAction: priorRejection.reviewedAction,
        },
      );
    }
    decision = await review.reviewer.review(proposal, signal ? { signal } : {});
  } catch (error) {
    if (
      signal?.aborted ||
      error instanceof ToolActionRejectedError ||
      error instanceof ToolActionReviewUnavailableError
    ) {
      throw error;
    }
    throw new ToolActionReviewUnavailableError({ cause: error });
  }
  if (decision.decision === "allow") {
    return decision;
  }
  const reviewedAction = projectedRejection(proposal, decision);
  const key = rejectionKey(
    toolName,
    input,
    proposal.context.userIntent,
    decision.decision,
  );
  if (key) {
    review.rejectedActions.push({
      decision: decision.decision,
      key,
      reason: decision.reason,
      reviewedAction,
      riskLevel: decision.riskLevel,
      userAuthorization: decision.userAuthorization,
    });
    appendVisibleRejection(review.priorRejections, reviewedAction);
  }
  throw new ToolActionRejectedError(decision.decision, decision.reason, {
    riskLevel: decision.riskLevel,
    reviewedAction,
    userAuthorization: decision.userAuthorization,
  });
}
