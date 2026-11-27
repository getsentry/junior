import { describe, expect, it, vi } from "vitest";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";
import { createCurrentGuardian } from "@/chat/guardian/current";
import {
  createToolActionReview,
  MAX_TOOL_ACTION_BATCH,
  reviewToolActions,
  ToolActionReviewUnavailableError,
  type ToolAction,
} from "@/chat/guardian/gate";
import type { Guardian, ReviewRequest } from "@/chat/guardian/guardian";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";
import { createApp, defineJuniorPlugins } from "@/app";
import { defineJuniorPlugin } from "@sentry/junior-plugin-api";
import {
  definition,
  LOCAL_DESTINATION,
  LOCAL_SOURCE,
  reviewContext,
  reviewToolAction,
} from "../../fixtures/guardian-gate";

describe("tool action review", () => {
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
          ? "Ask for that confirmation now, the way your instructions say to ask."
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
        tool.guardian = () => {
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

  it("escalates a review that cannot run to the run boundary", async () => {
    const failure = new Error("provider unavailable");
    const onFatal = vi.fn();
    const guardian: Guardian = {
      review: async () => {
        throw failure;
      },
    };
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "Generate the report.",
      },
      guardian: () => guardian,
      onFatal,
      onDecision: vi.fn(async () => undefined),
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
    // The current gate ends the Run when review cannot run.
    expect(onFatal).toHaveBeenCalledOnce();
  });

  it("sends the ordered messages of the work and one action for each call", async () => {
    const requests: ReviewRequest[] = [];
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "yes, go ahead",
        rootConversation: async () => ({
          messages: [
            { author: "user", text: "Draft the weekly report." },
            { author: "assistant", text: "Generate report weekly now?" },
            { author: "other person", text: "Also send it to me." },
            { author: "user", text: "yes, go ahead" },
          ],
          truncated: true,
        }),
      },
      guardian: () => ({
        review: async (request) => {
          requests.push(request);
          return request.actions.map(() => ({
            decision: "allow",
            reason: "The person confirmed it.",
          }));
        },
      }),
      onFatal: () => undefined,
      onDecision: vi.fn(async () => undefined),
    });

    await reviewToolAction(
      "tool-call",
      "generateReport",
      definition({
        approvalMode: "review",
        annotations: { destructiveHint: true },
      }),
      { reportId: "weekly" },
      actionReview,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.messages).toEqual([
      { from: "context", text: "[Older messages are not shown.]" },
      { from: "instruction", text: "Draft the weekly report." },
      { from: "context", text: "Generate report weekly now?" },
      { from: "other_person", text: "Also send it to me." },
      { from: "instruction", text: "yes, go ahead" },
    ]);
    expect(requests[0]!.actions).toEqual([
      {
        tool: "generateReport",
        input: { reportId: "weekly" },
        summary: "generateReport",
      },
    ]);
  });

  it("gives an MCP call its plugin's audience", async () => {
    const requests: ReviewRequest[] = [];
    await createApp({
      plugins: defineJuniorPlugins([
        defineJuniorPlugin({
          manifest: {
            name: "notes",
            displayName: "Notes",
            description: "Notes",
            mcp: {
              transport: "http",
              url: "https://mcp.notes.example.test/mcp",
              guardian: { audience: "internal" },
            },
          },
        }),
      ]),
    });
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "Put the numbers on the page.",
      },
      guardian: () => ({
        review: async (request) => {
          requests.push(request);
          return request.actions.map(() => ({
            decision: "allow" as const,
            reason: "The person asked for the update.",
          }));
        },
      }),
      onFatal: () => undefined,
      onDecision: vi.fn(async () => undefined),
    });

    await reviewToolAction(
      "tool-call",
      "callMcpTool",
      definition({
        approvalMode: "review",
        resolveApprovalMetadata: async () => ({
          serverHints: { readOnlyHint: false },
          name: "mcp__notes__update_page",
          source: { description: "Notes", id: "notes" },
        }),
      }),
      { tool_name: "mcp__notes__update_page", arguments: {} },
      actionReview,
    );

    expect(requests[0]!.actions[0]!).toMatchObject({
      target: {
        ref: "notes",
        audience: "internal",
      },
    });
  });

  it("reviews a shell command from its text, with the placeholders", async () => {
    const requests: ReviewRequest[] = [];
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "Push the fix.",
        reviewsShell: true,
      },
      guardian: () => ({
        review: async (request) => {
          requests.push(request);
          return request.actions.map(() => ({
            decision: "allow" as const,
            reason: "The person asked for the push.",
          }));
        },
      }),
      onFatal: () => undefined,
      onDecision: vi.fn(async () => undefined),
    });

    await reviewToolAction(
      "tool-call",
      "bash",
      // Like the real bash tool, it has no approval mode.
      definition(),
      {
        command:
          "git -C /vercel/sandbox/repos/demo push https://example.com/mirror.git fix/export:main",
      },
      actionReview,
    );

    expect(requests[0]!.actions[0]!).toMatchObject({
      tool: "bash",
    });
    expect(requests[0]!.sandbox).toEqual({ placeholders: [] });
  });

  it("fails only the action that cannot be reviewed in a batch", async () => {
    const actionReview = createToolActionReview({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:approval-test",
        destination: LOCAL_DESTINATION,
        source: LOCAL_SOURCE,
        userIntent: () => "Update both pages.",
      },
      guardian: () => ({
        review: async (request) => {
          if (
            request.actions.some((action) =>
              JSON.stringify(action.input).includes("huge"),
            )
          ) {
            throw new Error("The action is too large to review.");
          }
          return request.actions.map(() => ({
            decision: "allow" as const,
            reason: "The person asked for it.",
          }));
        },
      }),
      onFatal: () => undefined,
      onDecision: vi.fn(async () => undefined),
    });
    const tool = definition({ approvalMode: "review" });

    const results = await reviewToolActions(
      [
        {
          toolCallId: "small",
          toolName: "updatePage",
          tool,
          input: { page: "small" },
        },
        {
          toolCallId: "huge",
          toolName: "updatePage",
          tool,
          input: { page: "huge" },
        },
      ],
      actionReview,
    );

    expect(results.get("small")).toMatchObject({ allowed: true });
    expect(results.get("huge")).toMatchObject({
      allowed: false,
      error: { name: "ToolActionReviewUnavailableError" },
    });
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
      onFatal: () => undefined,
      onDecision: async () => {
        throw failure;
      },
      guardian: (batch) =>
        createCurrentGuardian(
          {
            review: async () => ({
              decision: "allow",
              reason: "The requested report is safe.",
              riskLevel: "low",
              userAuthorization: "high",
            }),
          },
          batch,
        ),
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
      if (proposal.input["slow"]) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return {
        decision: "deny",
        reason: `Rejected ${String(proposal.input["target"])}.`,
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
      onFatal: () => undefined,
      onDecision,
      guardian: (batch) => createCurrentGuardian({ review }, batch),
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
        decision: proposal.input["deny"] ? "deny" : "allow",
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
