/** Shared setup of the Guardian gate unit tests. */
import { vi } from "vitest";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import { createCurrentGuardian } from "@/chat/guardian/current";
import {
  createToolActionReview,
  reviewToolActions,
  type ToolActionReview,
  type ToolActionReviewContext,
} from "@/chat/guardian/gate";
import type { Review } from "@/chat/guardian/guardian";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";

export const LOCAL_SOURCE = {
  kind: "local",
  visibility: "private",
  conversationId: "local:approval-test",
} as const;
export const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:approval-test",
} as const;

/** A gate review of a scheduled run, with the given reviewer. */
export function reviewContext(
  reviewer: ToolActionReviewer,
  overrides: Partial<ToolActionReviewContext> = {},
): ToolActionReview {
  return createToolActionReview({
    context: {
      actor: {
        platform: "system",
        name: "scheduler",
      },
      conversationId: "local:approval-test",
      credentialContext: {
        actor: {
          platform: "system",
          name: "scheduler",
        },
        subject: {
          type: "user",
          userId: "U123",
          allowedWhen: "scheduled-automation",
          taskId: "task-123",
          binding: {
            type: "scheduled-automation",
            plugin: "scheduler",
            taskId: "task-123",
            signature: "must-not-reach-guardian",
          },
        },
      },
      destination: LOCAL_DESTINATION,
      source: LOCAL_SOURCE,
      userIntent: () => "Run my scheduled report.",
      evidence: () => ({
        entries: [
          { role: "user", text: "Run the report I described yesterday." },
        ],
        omittedEntries: 2,
      }),
      ...overrides,
    },
    onFatal: () => undefined,
    onDecision: vi.fn(async () => undefined),
    guardian: (batch) => createCurrentGuardian(reviewer, batch),
  });
}

/** Review a batch of one action, as the tool adapter does. */
export async function reviewToolAction(
  toolCallId: string,
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  review: ToolActionReview | undefined,
): Promise<Review | undefined> {
  const results = await reviewToolActions(
    [{ toolCallId, toolName, tool, input }],
    review,
  );
  const result = results.get(toolCallId)!;
  if (!result.allowed) {
    throw result.error;
  }
  return result.decision;
}

/** A plain tool definition with the given fields. */
export function definition(
  overrides: Partial<AnyToolDefinition> = {},
): AnyToolDefinition {
  return {
    description: "Generate the scheduled report.",
    inputSchema: {},
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}
