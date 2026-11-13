/**
 * Owns the execution gate for reviewable tool actions.
 *
 * Deterministic host checks establish authority before the model evaluates
 * untrusted action evidence.
 */
import type {
  Destination,
  Source,
  ToolPermission,
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
} from "@/chat/guardian/history";
import {
  addPriorRejection,
  projectToolActionRejection,
} from "@/chat/guardian/history";
import type {
  RootConversation,
  ScriptCallStatus,
  ToolActionDecision,
  ToolActionEvidence,
  ToolActionProposal,
  ToolActionReviewDecision,
  ToolActionReviewer,
  ToolActionScript,
} from "@/chat/guardian/proposal";
import { logException, withSpan } from "@/chat/logging";
import { ToolInputError } from "@/chat/tools/execution/tool-input-error";

/** Core-owned context used to prepare one exact action for Guardian. */
export interface ToolActionReviewContext {
  actor?: Actor;
  conversationId: string;
  credentialContext?: CredentialContext;
  destination: Destination;
  source: Source;
  userIntent?: () => string;
  evidence?: () => ToolActionEvidence;
  /** Read the Run's own Conversation when an action needs review. */
  rootConversation?: () => Promise<RootConversation>;
}

/** One exact tool call that the agent asked to run. */
export interface ToolAction {
  toolCallId: string;
  toolName: string;
  tool: AnyToolDefinition;
  input: Record<string, unknown>;
  /**
   * The model tool call that this action is part of. The rejection limit
   * counts each attempt once. Defaults to `toolCallId`.
   */
  attemptId?: string;
  /** Set when a Code Mode script made the call. The gate bounds it. */
  script?: {
    source: string;
    /** Earlier tool calls of the same script, oldest first. */
    calls: Array<{
      input: unknown;
      status: ScriptCallStatus;
      toolName: string;
    }>;
  };
}

/**
 * Review result for one action. An allowed action has a decision only when
 * Guardian reviewed it. A rejected action has the error that its tool call
 * must fail with.
 */
export type ToolActionReviewResult =
  | { allowed: true; decision?: ToolActionReviewDecision }
  | { allowed: false; error: Error };

/**
 * Review capability used immediately before tool execution. Callers go
 * through `reviewToolActions`, which owns the batch limit.
 */
export interface ToolActionReview {
  /** Review a batch of actions. The result has one entry per `toolCallId`. */
  review(
    actions: readonly ToolAction[],
    signal?: AbortSignal,
  ): Promise<Map<string, ToolActionReviewResult>>;
  projectToolResult<TResult extends { details?: unknown; isError?: boolean }>(
    toolCallId: string,
    result: TResult,
  ): TResult;
}

/** Instructions for an action that waits for the person's approval. */
function approvalPendingInstructions(reviewItemId: string): string {
  return [
    `The action did not run. It waits for the person's approval on review item ${reviewItemId}, which is already on their review desk. When they approve it, the runtime runs this exact call and sends you its result.`,
    "Do not call it again, ask for approval yourself, or get the same outcome another way.",
    "Tell the person in one short sentence that it waits for their approval, the way your instructions say to report. Then continue other work that does not need it.",
    "Do not mention Guardian, the runtime, policy, or internal review mechanics.",
  ].join("\n");
}

const ACTION_DENIAL_INSTRUCTIONS = [
  "This action was rejected due to unacceptable risk.",
  "The agent must not attempt the same outcome through a workaround, indirect execution, or policy circumvention.",
  "If the reason is missing or withheld authorization and exact confirmation could make the action allowable, ask for that confirmation now, the way your instructions say to ask. Name the exact action, target, and material side effects.",
  "Proceed only with a materially safer alternative. Otherwise, explain the specific risk the way your instructions say to report, without mentioning Guardian or internal review mechanics.",
].join("\n");

const ACTION_REVIEW_LIMIT_INSTRUCTIONS = [
  "This action was rejected due to unacceptable risk.",
  "Action review rejected three consecutive tool execution attempts.",
  "Do not retry this action or an equivalent write this turn.",
  "Explain the risk now, directly and concisely, the way your instructions say to report.",
  "Do not mention Guardian, the runtime, policy, or internal review mechanics.",
].join("\n");

/** Rejection instructions for the agent that proposed the action. */
function rejectionInstructions(
  step: { reviewItemId?: string },
  options: { exhausted: boolean },
): string {
  if (step.reviewItemId) {
    return approvalPendingInstructions(step.reviewItemId);
  }
  return options.exhausted
    ? ACTION_REVIEW_LIMIT_INSTRUCTIONS
    : ACTION_DENIAL_INSTRUCTIONS;
}

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
    > & {
      instructions?: string;
      reviewedAction?: ToolActionPriorRejection;
    } = {},
  ) {
    const instructions = assessment.instructions ?? ACTION_DENIAL_INSTRUCTIONS;
    super(`${instructions}\nReason: ${reason}`);
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

/** Telemetry-only marker when action review exhausts consecutive rejections. */
export class ToolActionReviewLimitError extends Error {
  constructor() {
    super("Action review rejected three consecutive tool execution attempts.");
    this.name = "ToolActionReviewLimitError";
  }
}

/**
 * True when an `auto` action must enter review. The tool's annotations alone
 * decide: an action marked read-only and not destructive skips review, like
 * MCP clients such as Codex do. MCP annotations come from the server, and
 * plugin annotations from the plugin. Anything else, including missing
 * annotations, is unknown risk.
 */
function autoActionNeedsReview(
  tool: AnyToolDefinition,
  resolved: ToolApprovalResolution | undefined,
): boolean {
  const annotations = resolved?.annotations ?? tool.annotations;
  return !(
    annotations?.readOnlyHint === true && annotations.destructiveHint !== true
  );
}

/**
 * Resolve what core does with one action. A core tool without a permission
 * stays outside review. `auto` asks for a call whose own annotations say
 * `destructiveHint: true`. A dispatcher, such as `callMcpTool`, describes
 * itself, not the call, so only its resolved metadata can ask. Each other
 * `auto` call is reviewed or allowed by `autoActionNeedsReview`. A permission
 * that is not known is reviewed.
 */
function effectivePermission(
  tool: AnyToolDefinition,
  resolved: ToolApprovalResolution | undefined,
): Exclude<ToolPermission, "auto"> {
  const permission = tool.permission;
  if (permission === undefined || permission === "allow") return "allow";
  if (permission === "ask" || permission === "deny") return permission;
  if (permission !== "auto") return "review";
  const callAnnotations = resolved
    ? resolved.annotations
    : tool.resolveApprovalMetadata
      ? undefined
      : tool.annotations;
  if (callAnnotations?.destructiveHint === true) return "ask";
  return autoActionNeedsReview(tool, resolved) ? "review" : "allow";
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
          ...("taskId" in credentialContext.subject
            ? { taskId: credentialContext.subject.taskId }
            : undefined),
          type: credentialContext.subject.type,
          userId: credentialContext.subject.userId,
        }
      : undefined;
  return {
    actor,
    ...(subject ? { subject } : undefined),
  };
}

function assertAuthoritativeContext(
  context: ToolActionReviewContext,
): asserts context is ToolActionReviewContext & {
  actor: Actor;
  userIntent: () => string;
} {
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
  rootConversation: RootConversation | undefined,
  script: ToolAction["script"],
): ToolActionProposal {
  const credential = actionCredential(context.credentialContext);
  return {
    context: {
      actor: actionActor(context.actor),
      conversationId: context.conversationId,
      ...(credential ? { credential } : undefined),
      destination: context.destination,
      source: context.source,
      userIntent: context.userIntent(),
    },
    ...(context.evidence ? { evidence: context.evidence() } : undefined),
    input,
    ...(priorRejections.length > 0
      ? {
          priorRejectedActions: priorRejections.map((rejection) => ({
            ...rejection,
          })),
        }
      : undefined),
    ...(rootConversation ? { rootConversation } : undefined),
    ...(script ? { script: boundedScript(script) } : undefined),
    tool: proposalTool(toolName, tool, input, resolved),
  };
}

const MAX_SCRIPT_SOURCE_CHARS = 16_000;
const MAX_SCRIPT_CALLS = 20;
const MAX_SCRIPT_CALL_INPUT_CHARS = 500;

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n[truncated]\n${text.slice(-half)}`;
}

/**
 * Bound the script provenance of one action, so a long script or many
 * earlier calls stay well inside the proposal size limit. Keep the most
 * recent calls, because they are nearest to the action.
 */
function boundedScript(
  script: NonNullable<ToolAction["script"]>,
): ToolActionScript {
  const calls = script.calls.slice(-MAX_SCRIPT_CALLS);
  return {
    calls: calls.map((call) => ({
      input: truncateMiddle(
        JSON.stringify(canonicalJson(call.input)) ?? "",
        MAX_SCRIPT_CALL_INPUT_CHARS,
      ),
      status: call.status,
      toolName: call.toolName,
    })),
    omittedCalls: script.calls.length - calls.length,
    source: truncateMiddle(script.source, MAX_SCRIPT_SOURCE_CHARS),
  };
}

/**
 * Build the `tool` field of a proposal: the tool as Guardian sees it for this
 * input. The resolved metadata of a dispatcher, such as `callMcpTool`, names
 * the real tool. The Guardian evals call this with the agent's own tools, so
 * they send the same shape as production.
 */
export function proposalTool(
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  resolved: ToolApprovalResolution | undefined,
): ToolActionProposal["tool"] {
  const name = resolved?.name ?? toolName;
  const annotations = resolved?.annotations ?? tool.annotations;
  const catalogSource = resolved?.source ?? tool.source;
  const proposalDescription = tool.describeProposal?.(input);
  return {
    ...(annotations ? { annotations } : undefined),
    description: resolved?.description ?? tool.description,
    ...(name !== toolName ? { dispatcherName: toolName } : undefined),
    ...(tool.identity ? { identity: tool.identity } : undefined),
    name,
    ...(proposalDescription ? { proposalDescription } : undefined),
    ...(catalogSource ? { catalogSource } : undefined),
  };
}

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
  decision: ActionRejection,
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
    decision: decision.decision,
    input,
    reason: decision.reason,
    ...(decision.riskLevel ? { riskLevel: decision.riskLevel } : undefined),
    tool: proposal.tool,
    ...(decision.userAuthorization
      ? { userAuthorization: decision.userAuthorization }
      : undefined),
  };
}

/** A core tool stays outside review unless it opts in. Plugin tools default to `auto`. */
function mayNeedReview(tool: AnyToolDefinition): boolean {
  return tool.permission !== undefined && tool.permission !== "allow";
}

/** How the gate handles one action before it runs. */
type ActionPlan =
  | { kind: "allow" }
  | { kind: "ask" | "deny" | "review"; proposal: ToolActionProposal };

/** Prepare the exact action that core or Guardian must decide, when needed. */
async function planToolAction(
  action: ToolAction,
  context: ToolActionReviewContext,
  priorRejections: ToolActionPriorRejection[],
): Promise<ActionPlan> {
  const { tool, input } = action;
  if (!mayNeedReview(tool)) {
    return { kind: "allow" };
  }
  const resolved = await tool.resolveApprovalMetadata?.(input);
  const permission = effectivePermission(tool, resolved);
  if (permission === "allow") {
    return { kind: "allow" };
  }
  assertAuthoritativeContext(context);
  const proposal = buildProposal(
    action.toolName,
    tool,
    input,
    resolved,
    context,
    priorRejections,
    // Only Guardian reads it. Read at review time, so a later message in the
    // root counts.
    permission === "review" ? await context.rootConversation?.() : undefined,
    action.script,
  );
  return { kind: permission, proposal };
}

/**
 * Most actions in one batch. A larger batch is rejected before any review,
 * so one script cannot start many Guardian model calls. 10 is a
 * conservative placeholder. The Code Mode bridge (#1987) sets the final
 * limit and tells the model about it.
 */
export const MAX_TOOL_ACTION_BATCH = 10;

/** Most Guardian reviews of one batch that run at the same time. */
const MAX_CONCURRENT_REVIEWS = 4;

/** Map items with at most `limit` calls of `fn` in flight, in input order. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** A rejection from core or Guardian, with Guardian's ratings when it decided. */
type ActionRejection = {
  decision: Exclude<ToolActionDecision, "allow">;
  reason: string;
} & Partial<Pick<ToolActionReviewDecision, "riskLevel" | "userAuthorization">>;

/**
 * Store the exact call with the Run's context and file its review item.
 * Return the item id, or undefined when no person can approve it in this
 * Run. Only the person's answer on that item can run the call.
 */
export type RequestToolApproval = (
  action: ToolAction,
  proposal: ToolActionProposal,
  reason: string,
) => Promise<string | undefined>;

const ASK_PERMISSION_REASON =
  "This tool runs only after the person approves each call.";
const DENY_PERMISSION_REASON = "This tool never runs.";
const NO_APPROVER_REASON =
  "No person can approve this action in this run: an automation has no person, and a person without a Junior account (made when they sign in to the Junior dashboard) cannot answer. Do not ask for approval in text.";

/** Outcome of the review step of one action, before gate state changes. */
type ReviewStep =
  | { kind: "skipped" }
  | {
      kind: "reviewed";
      decision: ToolActionReviewDecision;
      proposal: ToolActionProposal;
      reviewItemId?: string;
    }
  | {
      /** Core decided by the tool's permission, without Guardian. */
      kind: "decided";
      decision: ActionRejection;
      proposal: ToolActionProposal;
      reviewItemId?: string;
    }
  | { kind: "unavailable"; error: ToolActionReviewUnavailableError };

/** Create the core review path that prepares actions and enforces Guardian decisions. */
export function createToolActionReview(options: {
  context: ToolActionReviewContext;
  /** Persist a Guardian or rule decision before the action can continue. */
  onDecision(event: {
    decider: "guardian" | "rule";
    toolCallId: string;
    toolName: string;
    decision: Pick<ToolActionReviewDecision, "decision"> &
      Partial<
        Pick<
          ToolActionReviewDecision,
          "costUsd" | "riskLevel" | "userAuthorization"
        >
      >;
  }): Promise<void>;
  /** Escalate unavailable review to the owning agent-run boundary. */
  onFatal(error: ToolActionReviewUnavailableError): void;
  requestApproval: RequestToolApproval;
  priorRejections?: ToolActionPriorRejection[];
  reviewer: ToolActionReviewer;
}): ToolActionReview {
  const priorRejections = [...(options.priorRejections ?? [])];
  const pendingRejections = new Map<string, ToolActionRejectionMarker>();
  let consecutiveRejections = 0;
  /**
   * Rejection state of each attempt, so an attempt counts only once. Pi runs
   * a `codemode` call alone, so no other attempt changes the count while
   * its batches run.
   */
  const attempts = new Map<
    string,
    { before: number; exhausted: boolean; rejected: boolean }
  >();

  /**
   * File an approval for an action that must wait for a person. Without a
   * person who can approve, the action is denied.
   */
  const askPerson = async (
    action: ToolAction,
    proposal: ToolActionProposal,
    reason: string,
  ): Promise<{ decision: ActionRejection; reviewItemId?: string }> => {
    const reviewItemId = await options.requestApproval(
      action,
      proposal,
      reason,
    );
    return reviewItemId
      ? { decision: { decision: "ask", reason }, reviewItemId }
      : {
          decision: {
            decision: "deny",
            reason: `${reason} ${NO_APPROVER_REASON}`,
          },
        };
  };

  /**
   * Decide one action and record Guardian's decision. Gate state does not
   * change here, so concurrent reviews in one batch cannot corrupt it.
   */
  const reviewStep = async (
    action: ToolAction,
    rejections: ToolActionPriorRejection[],
    signal: AbortSignal | undefined,
  ): Promise<ReviewStep> => {
    try {
      const plan = await planToolAction(action, options.context, rejections);
      if (plan.kind === "allow") {
        return { kind: "skipped" };
      }
      const { proposal } = plan;
      if (plan.kind !== "review") {
        const decided: { decision: ActionRejection; reviewItemId?: string } =
          plan.kind === "deny"
            ? { decision: { decision: "deny", reason: DENY_PERMISSION_REASON } }
            : await askPerson(action, proposal, ASK_PERMISSION_REASON);
        await options.onDecision({
          decider: "rule",
          decision: decided.decision,
          toolCallId: action.toolCallId,
          toolName: proposal.tool.name,
        });
        return { kind: "decided", ...decided, proposal };
      }
      const decision = await options.reviewer.review(
        proposal,
        signal ? { signal } : {},
      );
      await options.onDecision({
        decider: "guardian",
        toolCallId: action.toolCallId,
        toolName: proposal.tool.name,
        decision,
      });
      if (decision.decision !== "ask") {
        return { kind: "reviewed", decision, proposal };
      }
      const asked = await askPerson(action, proposal, decision.reason);
      return {
        kind: "reviewed",
        ...(asked.reviewItemId
          ? { reviewItemId: asked.reviewItemId }
          : undefined),
        decision: { ...decision, ...asked.decision },
        proposal,
      };
    } catch (error) {
      if (signal?.aborted) {
        throw error;
      }
      return {
        kind: "unavailable",
        error:
          error instanceof ToolActionReviewUnavailableError
            ? error
            : new ToolActionReviewUnavailableError({ cause: error }),
      };
    }
  };

  /**
   * Count each attempt in the batch once, in batch order. An attempt with a
   * rejection adds one to the count from before the attempt, also when it
   * has allowed actions or spans several batches. An attempt with only
   * allowed actions resets the count. Skipped and unavailable actions do not
   * change it. Return the attempt state of each action.
   */
  const countAttempts = (
    actions: readonly ToolAction[],
    steps: readonly ReviewStep[],
  ) => {
    const states = actions.map((action) => {
      const id = action.attemptId ?? action.toolCallId;
      let state = attempts.get(id);
      if (!state) {
        state = {
          before: consecutiveRejections,
          exhausted: false,
          rejected: false,
        };
        attempts.set(id, state);
      }
      return state;
    });
    states.forEach((state, index) => {
      const step = steps[index]!;
      if (step.kind !== "reviewed" || state.rejected) {
        return;
      }
      if (step.decision.decision === "allow") {
        // A later action of the same attempt can still add one.
        consecutiveRejections = 0;
        return;
      }
      state.rejected = true;
      consecutiveRejections = state.before + 1;
      if (consecutiveRejections < MAX_CONSECUTIVE_REJECTIONS) {
        return;
      }
      state.exhausted = true;
      // Keep Sentry visibility for the limit without aborting the run.
      logException(
        new ToolActionReviewLimitError(),
        "guardian.action_review.exhausted",
        {
          "app.guardian.decision": step.decision.decision,
          "app.guardian.risk_level": step.decision.riskLevel,
          "app.guardian.user_authorization": step.decision.userAuthorization,
          "gen_ai.tool.name": step.proposal.tool.name,
          "gen_ai.tool.call.id": actions[index]!.toolCallId,
        },
      );
    });
    return states;
  };

  /** Apply one review step to gate state and return the action's result. */
  const settle = (
    toolCallId: string,
    step: ReviewStep,
    exhausted: boolean,
  ): ToolActionReviewResult => {
    if (step.kind === "skipped") {
      return { allowed: true };
    }
    if (step.kind === "unavailable") {
      options.onFatal(step.error);
      return { allowed: false, error: step.error };
    }
    const { proposal } = step;
    const verdict = step.decision.decision;
    if (verdict === "allow") {
      return {
        allowed: true,
        decision: { ...step.decision, decision: verdict },
      };
    }
    const decision: ActionRejection = { ...step.decision, decision: verdict };
    const reviewedAction = projectedRejection(proposal, decision);
    addPriorRejection(priorRejections, reviewedAction);
    pendingRejections.set(toolCallId, {
      decision: decision.decision,
      priorRejection: reviewedAction,
      reason: reviewedAction.reason,
      ...(decision.riskLevel ? { riskLevel: decision.riskLevel } : undefined),
      ...(decision.userAuthorization
        ? { userAuthorization: decision.userAuthorization }
        : undefined),
      version: 1,
    });
    return {
      allowed: false,
      error: new ToolActionRejectedError(decision.decision, decision.reason, {
        instructions: rejectionInstructions(step, { exhausted }),
        riskLevel: decision.riskLevel,
        reviewedAction,
        userAuthorization: decision.userAuthorization,
      }),
    };
  };

  return {
    async review(actions, signal) {
      return await withSpan(
        "guardian.action_review",
        "guardian.action_review",
        {},
        async () => {
          // Each action sees the same prior rejections, so the order in
          // which concurrent reviews finish cannot change a proposal.
          const rejections = [...priorRejections];
          const steps = await mapConcurrent(
            actions,
            MAX_CONCURRENT_REVIEWS,
            (action) => reviewStep(action, rejections, signal),
          );
          // Change gate state in batch order, so it does not depend on
          // which review finished first.
          const states = countAttempts(actions, steps);
          return new Map(
            actions.map((action, index) => [
              action.toolCallId,
              settle(
                action.toolCallId,
                steps[index]!,
                states[index]!.exhausted,
              ),
            ]),
          );
        },
        { "app.guardian.batch.size": actions.length },
      );
    },
    projectToolResult(toolCallId, result) {
      return projectToolActionRejection(pendingRejections, toolCallId, result);
    },
  };
}

/**
 * Review a batch of exact tool actions immediately before execution. The
 * result has one entry per `toolCallId`. A batch over
 * `MAX_TOOL_ACTION_BATCH` fails each action before any review; the count
 * includes actions that need no review.
 */
export async function reviewToolActions(
  actions: readonly ToolAction[],
  review: ToolActionReview | undefined,
  signal?: AbortSignal,
): Promise<Map<string, ToolActionReviewResult>> {
  const ids = new Set(actions.map((action) => action.toolCallId));
  if (ids.size !== actions.length) {
    throw new Error("A tool action batch has a duplicate toolCallId.");
  }
  if (actions.length > MAX_TOOL_ACTION_BATCH) {
    const error = new ToolInputError(
      `Too many tool calls at once (${actions.length}). Action review accepts at most ${MAX_TOOL_ACTION_BATCH} calls at once; issue fewer.`,
    );
    return new Map(
      actions.map((action) => [action.toolCallId, { allowed: false, error }]),
    );
  }
  if (!actions.some((action) => mayNeedReview(action.tool))) {
    return new Map(
      actions.map((action) => [action.toolCallId, { allowed: true }]),
    );
  }
  if (!review) {
    return new Map(
      actions.map((action) => [
        action.toolCallId,
        mayNeedReview(action.tool)
          ? { allowed: false, error: new ToolActionReviewUnavailableError() }
          : { allowed: true },
      ]),
    );
  }
  return await review.review(actions, signal);
}
