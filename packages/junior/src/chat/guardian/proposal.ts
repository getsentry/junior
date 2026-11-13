/**
 * The exact request that Guardian reviews for one tool action.
 *
 * The gate builds it, the reviewer renders it into the prompt, and the
 * Guardian evals build it as snapshots. Only `context` is authoritative and
 * comes from core. Each other field is untrusted evidence.
 */
import type {
  Destination,
  Source,
  ToolAnnotations,
} from "@sentry/junior-plugin-api";
import type { ToolActionPriorRejection } from "@/chat/guardian/history";

/** Outcome available to the action reviewer. */
export type ToolActionDecision = "allow" | "ask" | "deny";

/** Intrinsic risk of one action, as Guardian rates it. */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** How clearly the user authorized one action, as Guardian rates it. */
export const USER_AUTHORIZATION_LEVELS = [
  "high",
  "medium",
  "low",
  "unknown",
] as const;
export type UserAuthorization = (typeof USER_AUTHORIZATION_LEVELS)[number];

/** Guardian result for one action, with the decision that code derived. */
export interface ToolActionReviewDecision {
  costUsd?: number;
  decision: ToolActionDecision;
  reason: string;
  riskLevel: RiskLevel;
  /** Named policy rule that set the decision, or `none`. Diagnostic only. */
  rule?: string;
  userAuthorization: UserAuthorization;
}

/** Bounded transcript entries of the Run, without aligned authors. */
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

/**
 * Every line break that can start a new visible line. Guardian puts a label on
 * each line, so the root read and the prompt split on all of them.
 */
export const ROOT_LINE_BREAK = /\r\n|[\n\r\u2028\u2029\u0085]/;

/** One root Conversation message, labeled with its real author. */
export interface RootConversationMessage {
  /**
   * `user` is a message from the Run's own Actor. Only it can authorize an
   * action. Each other label is only context.
   */
  author: "user" | "assistant" | "other person" | "event" | "system";
  text: string;
}

/**
 * Bounded projection of the Run's own Conversation, read by core when
 * Guardian reviews one action.
 */
export interface RootConversation {
  messages: RootConversationMessage[];
  /** Older root messages are not in `messages`. */
  truncated: boolean;
}

/** Outcome of one earlier tool call of a Code Mode script. */
export type ScriptCallStatus = "completed" | "failed" | "rejected";

/**
 * Code Mode script that issued the action, bounded by core. It is untrusted
 * evidence: it shows where data in the input came from, and it never
 * authorizes the action.
 */
export interface ToolActionScript {
  /** Earlier tool calls of the same script, oldest first. */
  calls: Array<{ input: string; status: ScriptCallStatus; toolName: string }>;
  /** Older calls that are not in `calls`. */
  omittedCalls: number;
  source: string;
}

/**
 * Core facts for a tool with approval mode `confirm`. Code uses them to
 * require the user's confirmation; they are not in the model prompt.
 */
export interface ToolActionConfirmation {
  /**
   * An earlier Turn of this Conversation rejected the same tool with the
   * same input with `ask`. Only a later Turn can carry the user's answer.
   */
  askedInEarlierTurn: boolean;
}

/** Exact model-review request; only core-supplied context carries authority. */
export interface ToolActionProposal {
  /** Set when the tool's approval mode is `confirm`. */
  confirmation?: ToolActionConfirmation;
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
          | "scheduled-automation"
          | "event-automation"
          | "timer-watch";
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
  /** The root Conversation, with each message labeled by its real author. */
  rootConversation?: RootConversation;
  /** Set when a Code Mode script made the call. */
  script?: ToolActionScript;
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
