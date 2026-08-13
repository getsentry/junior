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
import { projectToolActionRejection } from "@/chat/tool-support/action-review-history";

/** Outcome available to the action reviewer. */
export type ToolActionDecision = "allow" | "ask" | "deny";

export interface ToolActionReviewDecision {
  costUsd?: number;
  decision: ToolActionDecision;
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  userAuthorization: "high" | "medium" | "low" | "unknown";
}

export interface ToolActionEvidence {
  entries: Array<{
    role:
      | "assistant"
      | "user"
      | `tool ${string} call`
      | `tool ${string} result`;
    text: string;
  }>;
  omittedEntries: number;
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
        allowedWhen:
          | "private-direct-conversation"
          | "scheduled-task"
          | "event-task";
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

/** Guardian capability for one schema-constrained action proposal. */
export interface ToolActionReviewer {
  review(
    proposal: ToolActionProposal,
    options?: { signal?: AbortSignal },
  ): Promise<ToolActionReviewDecision>;
}

/** Core-owned context used to prepare one exact action for Guardian. */
export interface ToolActionReviewContext {
  actor?: Actor;
  conversationId?: string;
  credentialContext?: CredentialContext;
  destination: Destination;
  source: Source;
  userIntent?: () => string;
  evidence?: () => ToolActionEvidence;
}

/** Review capability used immediately before tool execution. */
export interface ToolActionReview {
  review(
    toolCallId: string,
    toolName: string,
    tool: AnyToolDefinition,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolActionReviewDecision | undefined>;
  projectToolResult<TResult extends { details?: unknown; isError?: boolean }>(
    toolCallId: string,
    result: TResult,
  ): TResult;
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

/** Stable message for the bounded action-review rejection stop. */
export const TOOL_ACTION_REVIEW_LIMIT_MESSAGE =
  "Action review rejected three consecutive tool execution attempts; the run was interrupted.";

/** The execution slice exceeded its bounded sequence of rejected actions. */
export class ToolActionReviewLimitError extends Error {
  constructor() {
    super(TOOL_ACTION_REVIEW_LIMIT_MESSAGE);
    this.name = "ToolActionReviewLimitError";
  }
}

/** Keep core tools outside action review unless they explicitly opt in. */
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
          ...(credentialContext.subject.allowedWhen !==
          "private-direct-conversation"
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
  context: ToolActionReviewContext,
): asserts context is ToolActionReviewContext & {
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
  context: ToolActionReviewContext & {
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
const MAX_CONSECUTIVE_REJECTIONS = 3;

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

/** Prepare the exact action that Guardian must review, when review is required. */
async function prepareToolActionReview(
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  context: ToolActionReviewContext,
  priorRejections: ToolActionPriorRejection[],
): Promise<ToolActionProposal | undefined> {
  if (tool.approvalMode === undefined || tool.approvalMode === "approve") {
    return;
  }
  const resolved = await tool.resolveApprovalMetadata?.(input);
  if (effectiveApprovalMode(tool, resolved) === "approve") {
    return;
  }
  assertAuthoritativeContext(context);
  return buildProposal(
    toolName,
    tool,
    input,
    resolved,
    context,
    priorRejections,
  );
}

/** Create the core review path that prepares actions and enforces Guardian decisions. */
export function createToolActionReview(options: {
  context: ToolActionReviewContext;
  /** Persist the Guardian decision before the reviewed action can continue. */
  onDecision(event: {
    toolCallId: string;
    toolName: string;
    decision: ToolActionReviewDecision;
  }): Promise<void>;
  /** Escalate terminal review failures to the owning agent-run boundary. */
  onFatal(
    error: ToolActionReviewUnavailableError | ToolActionReviewLimitError,
  ): void;
  priorRejections?: ToolActionPriorRejection[];
  reviewer: ToolActionReviewer;
}): ToolActionReview {
  const priorRejections = [...(options.priorRejections ?? [])];
  const pendingRejections = new Map<string, ToolActionRejectionMarker>();
  let consecutiveRejections = 0;

  return {
    async review(toolCallId, toolName, tool, input, signal) {
      let proposal: ToolActionProposal | undefined;
      let decision: ToolActionReviewDecision;
      try {
        proposal = await prepareToolActionReview(
          toolName,
          tool,
          input,
          options.context,
          priorRejections,
        );
        if (!proposal) {
          return;
        }
        decision = await options.reviewer.review(
          proposal,
          signal ? { signal } : {},
        );
        await options.onDecision({
          toolCallId,
          toolName: proposal.tool.name,
          decision,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
        const unavailableError =
          error instanceof ToolActionReviewUnavailableError
            ? error
            : new ToolActionReviewUnavailableError({ cause: error });
        options.onFatal(unavailableError);
        throw unavailableError;
      }
      if (decision.decision === "allow") {
        consecutiveRejections = 0;
        return decision;
      }
      const reviewedAction = projectedRejection(proposal, decision);
      appendVisibleRejection(priorRejections, reviewedAction);
      consecutiveRejections += 1;
      if (consecutiveRejections >= MAX_CONSECUTIVE_REJECTIONS) {
        const limitError = new ToolActionReviewLimitError();
        options.onFatal(limitError);
        throw limitError;
      }
      pendingRejections.set(toolCallId, {
        decision: decision.decision,
        priorRejection: reviewedAction,
        reason: reviewedAction.reason,
        riskLevel: decision.riskLevel,
        userAuthorization: decision.userAuthorization,
        version: 1,
      });
      throw new ToolActionRejectedError(decision.decision, decision.reason, {
        riskLevel: decision.riskLevel,
        reviewedAction,
        userAuthorization: decision.userAuthorization,
      });
    },
    projectToolResult(toolCallId, result) {
      return projectToolActionRejection(pendingRejections, toolCallId, result);
    },
  };
}

/** Review one exact tool action immediately before execution when required. */
export async function reviewToolAction(
  toolCallId: string,
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  review: ToolActionReview | undefined,
  signal?: AbortSignal,
): Promise<ToolActionReviewDecision | undefined> {
  if (tool.approvalMode === undefined || tool.approvalMode === "approve") {
    return;
  }
  if (!review) {
    throw new ToolActionReviewUnavailableError();
  }
  return review.review(toolCallId, toolName, tool, input, signal);
}
