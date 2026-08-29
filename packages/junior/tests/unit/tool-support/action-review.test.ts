import { describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import {
  createToolActionReview,
  reviewToolAction,
  ToolActionReviewUnavailableError,
  type ToolActionReview,
  type ToolActionReviewContext,
  type ToolActionReviewer,
} from "@/chat/tool-support/action-review";

const LOCAL_SOURCE = {
  kind: "local",
  visibility: "private",
  conversationId: "local:approval-test",
} as const;
const LOCAL_DESTINATION = {
  platform: "local",
  conversationId: "local:approval-test",
} as const;

function reviewContext(
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
          allowedWhen: "scheduled-task",
          taskId: "task-123",
          binding: {
            type: "scheduled-task",
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
    onDecision: vi.fn(async () => undefined),
    onFatal: vi.fn(),
    reviewer,
  });
}

function definition(
  overrides: Partial<AnyToolDefinition> = {},
): AnyToolDefinition {
  return {
    description: "Generate the scheduled report.",
    inputSchema: {},
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

describe("tool action review", () => {
  it("preserves execution behavior for unclassified core tools", async () => {
    const reviewer = { review: vi.fn() };
    const resolveApprovalMetadata = vi.fn();

    await reviewToolAction(
      "tool-call",
      "generateReport",
      definition({ resolveApprovalMetadata }),
      { reportId: "weekly" },
      reviewContext(reviewer),
    );

    expect(reviewer.review).not.toHaveBeenCalled();
    expect(resolveApprovalMetadata).not.toHaveBeenCalled();
  });

  it("reviews auto plugin actions with exact input and safe context", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "Matches the scheduled request.",
      riskLevel: "low",
      userAuthorization: "high",
    }));
    const tool = definition({
      approvalMode: "auto",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      describeProposal: ({ reportId }) => `Generate report ${reportId}.`,
      identity: {
        id: "scheduler.generateReport",
        name: "generateReport",
        plugin: "scheduler",
      },
      source: {
        id: "scheduler",
        description: "Scheduled work",
      },
    });

    await reviewToolAction(
      "tool-call",
      "scheduler_generateReport",
      tool,
      { reportId: "weekly" },
      reviewContext({ review }),
    );

    const proposal = review.mock.calls[0]![0];
    expect(proposal).toMatchObject({
      context: {
        actor: { platform: "system", name: "scheduler" },
        conversationId: "local:approval-test",
        credential: {
          actor: { platform: "system", name: "scheduler" },
          subject: {
            allowedWhen: "scheduled-task",
            taskId: "task-123",
            type: "user",
            userId: "U123",
          },
        },
        userIntent: "Run my scheduled report.",
      },
      evidence: {
        entries: [
          { role: "user", text: "Run the report I described yesterday." },
        ],
        omittedEntries: 2,
      },
      input: { reportId: "weekly" },
      tool: {
        name: "scheduler_generateReport",
        proposalDescription: "Generate report weekly.",
      },
    });
    expect(JSON.stringify(proposal)).not.toContain("must-not-reach-guardian");
  });

  it("reviews auto actions when tool annotations are missing", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "Unknown risk needs review.",
      riskLevel: "medium",
      userAuthorization: "medium",
    }));

    await reviewToolAction(
      "tool-call",
      "callMcpTool",
      definition({
        approvalMode: "auto",
        // Partial annotations are still unknown risk.
        annotations: {
          destructiveHint: false,
          readOnlyHint: true,
        },
        resolveApprovalMetadata: async () => ({
          annotations: {
            destructiveHint: false,
            readOnlyHint: true,
          },
          description: "Call a remote MCP tool.",
          name: "mcp__demo__search",
        }),
      }),
      { tool_name: "mcp__demo__search" },
      reviewContext({ review }),
    );

    expect(review).toHaveBeenCalledTimes(1);
  });

  it("reviews auto actions when annotations are absent", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "Unknown risk needs review.",
      riskLevel: "medium",
      userAuthorization: "medium",
    }));

    await reviewToolAction(
      "tool-call",
      "callMcpTool",
      definition({
        approvalMode: "auto",
        resolveApprovalMetadata: async () => ({
          description: "Call a remote MCP tool with no annotations.",
          name: "mcp__demo__search",
        }),
      }),
      { tool_name: "mcp__demo__search" },
      reviewContext({ review }),
    );

    expect(review).toHaveBeenCalledTimes(1);
  });

  it("auto-approves only fully annotated safe non-plugin actions", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>();

    await reviewToolAction(
      "tool-call",
      "localSafeTool",
      definition({
        approvalMode: "auto",
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
      }),
      {},
      reviewContext({ review }),
    );

    expect(review).not.toHaveBeenCalled();
  });

  it("returns ask and deny decisions as expected tool rejections", async () => {
    for (const decision of ["ask", "deny"] as const) {
      const action = reviewToolAction(
        "tool-call",
        "generateReport",
        definition({ approvalMode: "review" }),
        { reportId: "weekly" },
        reviewContext({
          review: async () => ({
            decision,
            reason: "The destination is surprising.",
            riskLevel: "medium",
            userAuthorization: "low",
          }),
        }),
      );

      await expect(action).rejects.toMatchObject({
        decision,
        name: "ToolActionRejectedError",
      });
      await expect(action).rejects.toThrow(
        decision === "ask"
          ? "respond to the user now with a direct, concise confirmation question"
          : "If the reason is missing or withheld authorization",
      );
    }
  });

  it("shows prior denials to alternate tools", async () => {
    const review = vi
      .fn<ToolActionReviewer["review"]>()
      .mockResolvedValueOnce({
        decision: "deny",
        reason: "Deleting the workspace is outside the request.",
        riskLevel: "critical",
        userAuthorization: "low",
      })
      .mockResolvedValueOnce({
        decision: "deny",
        reason: "This is an equivalent destructive action.",
        riskLevel: "critical",
        userAuthorization: "low",
      });
    const context = reviewContext({ review });
    const input = { workspaceId: "workspace-123" };

    await expect(
      reviewToolAction(
        "delete-call",
        "deleteWorkspace",
        definition({ approvalMode: "review" }),
        input,
        context,
      ),
    ).rejects.toMatchObject({ decision: "deny" });
    await expect(
      reviewToolAction(
        "cleanup-call",
        "runWorkspaceCleanup",
        definition({ approvalMode: "review" }),
        { target: "workspace-123", mode: "permanent" },
        context,
      ),
    ).rejects.toMatchObject({ decision: "deny" });
    expect(review.mock.calls[1]?.[0].priorRejectedActions).toEqual([
      expect.objectContaining({
        decision: "deny",
        input,
        reason: "Deleting the workspace is outside the request.",
        tool: expect.objectContaining({ name: "deleteWorkspace" }),
      }),
    ]);
  });

  it("fails closed before Guardian when authoritative context is missing", async () => {
    const reviewer = { review: vi.fn() };
    const actionReview = reviewContext(reviewer, { actor: undefined });

    await expect(
      reviewToolAction(
        "tool-call",
        "generateReport",
        definition({ approvalMode: "review" }),
        { reportId: "weekly" },
        actionReview,
      ),
    ).rejects.toBeInstanceOf(ToolActionReviewUnavailableError);
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it.each([
    [
      "approval metadata",
      (tool: AnyToolDefinition, failure: Error) => {
        tool.resolveApprovalMetadata = () => {
          throw failure;
        };
        return {};
      },
    ],
    [
      "proposal description",
      (tool: AnyToolDefinition, failure: Error) => {
        tool.describeProposal = () => {
          throw failure;
        };
        return {};
      },
    ],
    [
      "conversation evidence",
      (_tool: AnyToolDefinition, failure: Error) => ({
        evidence: () => {
          throw failure;
        },
      }),
    ],
  ])(
    "fails closed when %s preparation fails",
    async (_name, arrangeFailure) => {
      const reviewer = { review: vi.fn() };
      const tool = definition({ approvalMode: "review" });
      const failure = new Error("review setup failed");
      const contextOverrides = arrangeFailure(tool, failure);
      const actionReview = reviewContext(reviewer, contextOverrides);

      await expect(
        reviewToolAction(
          "tool-call",
          "generateReport",
          tool,
          { reportId: "weekly" },
          actionReview,
        ),
      ).rejects.toMatchObject({
        cause: failure,
        name: "ToolActionReviewUnavailableError",
      });
      expect(reviewer.review).not.toHaveBeenCalled();
    },
  );

  it("fails closed when Guardian cannot produce a decision", async () => {
    const action = reviewToolAction(
      "tool-call",
      "generateReport",
      definition({ approvalMode: "review" }),
      { reportId: "weekly" },
      reviewContext({
        review: async () => {
          throw new Error("provider unavailable");
        },
      }),
    );

    await expect(action).rejects.toBeInstanceOf(
      ToolActionReviewUnavailableError,
    );
  });

  it("fails closed when the Guardian decision cannot be recorded", async () => {
    const failure = new Error("event log unavailable");
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "Generate the report.",
      },
      onDecision: async () => {
        throw failure;
      },
      onFatal: vi.fn(),
      reviewer: {
        review: async () => ({
          decision: "allow",
          reason: "The requested report is safe.",
          riskLevel: "low",
          userAuthorization: "high",
        }),
      },
    });

    await expect(
      reviewToolAction(
        "tool-call",
        "generateReport",
        definition({ approvalMode: "review" }),
        { reportId: "weekly" },
        actionReview,
      ),
    ).rejects.toMatchObject({
      cause: failure,
      name: "ToolActionReviewUnavailableError",
    });
  });
});
