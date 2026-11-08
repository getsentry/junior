import { describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import {
  createToolActionReview,
  MAX_TOOL_ACTION_BATCH,
  reviewToolActions,
  ToolActionReviewUnavailableError,
  type ToolAction,
  type ToolActionReview,
  type ToolActionReviewContext,
} from "@/chat/guardian/gate";
import type {
  ToolActionReviewDecision,
  ToolActionReviewer,
} from "@/chat/guardian/proposal";

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
    onDecision: vi.fn(async () => undefined),
    onFatal: vi.fn(),
    reviewer,
  });
}

/** Review a batch of one action, as the tool adapter does. */
async function reviewToolAction(
  toolCallId: string,
  toolName: string,
  tool: AnyToolDefinition,
  input: Record<string, unknown>,
  review: ToolActionReview | undefined,
): Promise<ToolActionReviewDecision | undefined> {
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
            allowedWhen: "scheduled-automation",
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

  it("sends requester instructions to Guardian only for an Event Source", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "The requester asked for it.",
      riskLevel: "low",
      userAuthorization: "high",
    }));
    const tool = definition({ approvalMode: "review" });
    const requesterInstructions = [
      {
        actor: {
          email: "requester@example.com",
          platform: "slack" as const,
          teamId: "T123",
          userId: "U123",
        },
        text: "File the follow-up issue.",
      },
    ];
    const eventSource = {
      kind: "event",
      eventKey: "comment-1",
      eventType: "pull_request.comment.created",
      identifier: "getsentry/junior#1",
      namespace: "github",
    } as const;

    for (const source of [eventSource, LOCAL_SOURCE]) {
      await reviewToolAction(
        `call-${source.kind}`,
        "createIssue",
        tool,
        { repo: "getsentry/other" },
        reviewContext({ review }, { requesterInstructions, source }),
      );
    }

    expect(review.mock.calls[0]![0].requesterInstructions).toEqual([
      {
        actor: { platform: "slack", teamId: "T123", userId: "U123" },
        text: "File the follow-up issue.",
      },
    ]);
    expect(review.mock.calls[1]![0]).not.toHaveProperty(
      "requesterInstructions",
    );
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

  it("rejects a batch over the limit before any review", async () => {
    const reviewer = { review: vi.fn() };
    // Actions that need no review count toward the limit.
    const actions: ToolAction[] = Array.from(
      { length: MAX_TOOL_ACTION_BATCH + 1 },
      (_, index) => ({
        toolCallId: `call-${index}`,
        toolName: "generateReport",
        tool: definition(index === 0 ? { approvalMode: "review" } : {}),
        input: {},
      }),
    );

    const results = await reviewToolActions(actions, reviewContext(reviewer));

    expect(results.size).toBe(actions.length);
    for (const result of results.values()) {
      expect(result).toMatchObject({
        allowed: false,
        error: {
          name: "ToolInputError",
          message: expect.stringContaining(
            `at most ${MAX_TOOL_ACTION_BATCH} calls at once; issue fewer`,
          ),
        },
      });
    }
    expect(reviewer.review).not.toHaveBeenCalled();
  });

  it("reviews a batch against one rejection snapshot", async () => {
    const onDecision = vi.fn(async () => undefined);
    // The first action finishes last, so completion order differs from
    // batch order.
    const review = vi.fn<ToolActionReviewer["review"]>(async (proposal) => {
      if (proposal.input.slow) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        decision: "deny",
        reason: `Rejected ${String(proposal.input.target)}.`,
        riskLevel: "high",
        userAuthorization: "low",
      };
    });
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "Clean up the preview workspaces.",
      },
      onDecision,
      onFatal: vi.fn(),
      reviewer: { review },
    });
    const reviewed = definition({ approvalMode: "review" });

    const results = await reviewToolActions(
      [
        {
          toolCallId: "a",
          toolName: "deleteWorkspace",
          tool: reviewed,
          input: { slow: true, target: "a" },
        },
        {
          toolCallId: "core",
          toolName: "generateReport",
          tool: definition(),
          input: {},
        },
        {
          toolCallId: "b",
          toolName: "deleteWorkspace",
          tool: reviewed,
          input: { target: "b" },
        },
        {
          toolCallId: "c",
          toolName: "deleteWorkspace",
          tool: reviewed,
          input: { target: "c" },
        },
      ],
      actionReview,
    );

    expect(results.get("core")).toEqual({ allowed: true });
    for (const id of ["a", "b", "c"]) {
      expect(results.get(id)).toMatchObject({
        allowed: false,
        error: { decision: "deny", reason: `Rejected ${id}.` },
      });
    }
    for (const [proposal] of review.mock.calls) {
      expect(proposal.priorRejectedActions).toBeUndefined();
    }
    expect(onDecision).toHaveBeenCalledTimes(3);
  });

  it("counts each attempt once toward the rejection limit", async () => {
    const actionReview = reviewContext({
      review: vi.fn<ToolActionReviewer["review"]>(async (proposal) => ({
        decision: proposal.input.deny ? "deny" : "allow",
        reason: "Decided by the test.",
        riskLevel: "high",
        userAuthorization: "low",
      })),
    });
    const reviewed = definition({ approvalMode: "review" });
    const exhausted = "rejected three consecutive tool execution attempts";
    const attempt = async (
      attemptId: string,
      calls: Array<[toolCallId: string, deny: boolean]>,
    ) =>
      await reviewToolActions(
        calls.map(([toolCallId, deny]) => ({
          attemptId,
          toolCallId,
          toolName: "deleteWorkspace",
          tool: reviewed,
          input: { deny },
        })),
        actionReview,
      );
    const limited = (
      results: Awaited<ReturnType<typeof attempt>>,
      toolCallId: string,
    ) =>
      (results.get(toolCallId) as { error: Error }).error.message.includes(
        exhausted,
      );

    // An allowed action does not cancel a rejection in the same attempt.
    const first = await attempt("m", [
      ["m1", false],
      ["m2", true],
    ]);
    expect(limited(first, "m2")).toBe(false);
    expect(limited(await attempt("n", [["n1", true]]), "n1")).toBe(false);
    // An attempt over several batches adds one to the count from before it.
    await attempt("o", [["o1", false]]);
    expect(limited(await attempt("o", [["o2", true]]), "o2")).toBe(true);
    expect(limited(await attempt("o", [["o3", true]]), "o3")).toBe(true);
    // An attempt with only allowed actions resets the count.
    await attempt("p", [["p1", false]]);
    expect(limited(await attempt("q", [["q1", true]]), "q1")).toBe(false);
  });

  it("bounds script provenance in the proposal", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "Matches the request.",
      riskLevel: "low",
      userAuthorization: "high",
    }));
    const calls = Array.from({ length: 25 }, (_, index) => ({
      input: { index, text: "x".repeat(2_000) },
      status: "completed" as const,
      toolName: "readFile",
    }));

    await reviewToolActions(
      [
        {
          toolCallId: "script-call",
          toolName: "generateReport",
          tool: definition({ approvalMode: "review" }),
          input: { reportId: "weekly" },
          script: { calls, source: "y".repeat(40_000) },
        },
      ],
      reviewContext({ review }),
    );

    const script = review.mock.calls[0]![0].script!;
    expect(script.omittedCalls).toBe(5);
    expect(script.calls).toHaveLength(20);
    expect(script.calls[0]).toMatchObject({
      input: expect.stringContaining('{"index":5,'),
      status: "completed",
      toolName: "readFile",
    });
    expect(script.calls[0]!.input.length).toBeLessThan(600);
    expect(script.source.length).toBeLessThan(17_000);
    expect(script.source).toContain("[truncated]");
  });
});
