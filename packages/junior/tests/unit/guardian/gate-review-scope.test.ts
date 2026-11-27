import { describe, expect, it, vi } from "vitest";
import type { ToolActionReviewer } from "@/chat/guardian/proposal";
import {
  definition,
  reviewContext,
  reviewToolAction,
} from "../../fixtures/guardian-gate";

describe("which tool actions Guardian reviews", () => {
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
        readOnlyHint: false,
      },
      guardian: ({ reportId }) => ({
        summary: `Generate report ${reportId}.`,
      }),
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
        // Without `readOnlyHint: true`, partial annotations are unknown risk.
        annotations: {
          destructiveHint: false,
          openWorldHint: false,
        },
        resolveApprovalMetadata: async () => ({
          serverHints: {
            destructiveHint: false,
            openWorldHint: false,
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

  it("skips review of a read-only plugin action", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>();
    const pluginTool = definition({
      approvalMode: "auto",
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: true,
      },
      identity: {
        id: "github.getIssue",
        name: "getIssue",
        plugin: "github",
      },
      source: { id: "github", description: "GitHub" },
    });

    await reviewToolAction(
      "plugin-call",
      "github_getIssue",
      pluginTool,
      { issue: 1, repo: "getsentry/junior" },
      reviewContext({ review }),
    );

    expect(review).not.toHaveBeenCalled();
  });

  it("reviews a remote MCP tool that its server marks read-only", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "The server's marks are only hints.",
      riskLevel: "medium",
      userAuthorization: "medium",
    }));
    const mcpTool = definition({
      approvalMode: "auto",
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false,
      },
      resolveApprovalMetadata: async () => ({
        serverHints: { destructiveHint: false, readOnlyHint: true },
        description: "Search Linear issues.",
        name: "mcp__linear__search_issues",
        source: { id: "linear", description: "MCP provider linear" },
      }),
    });

    await reviewToolAction(
      "mcp-call",
      "callMcpTool",
      mcpTool,
      { tool_name: "mcp__linear__search_issues" },
      reviewContext({ review }),
    );

    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0].tool).toMatchObject({
      name: "mcp__linear__search_issues",
      serverHints: { destructiveHint: false, readOnlyHint: true },
    });
    expect(review.mock.calls[0]![0].tool.annotations).toBeUndefined();
  });

  it("skips review of MCP actions that the plugin lists", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>();

    await reviewToolAction(
      "mcp-call",
      "callMcpTool",
      definition({
        approvalMode: "auto",
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        resolveApprovalMetadata: async () => ({
          description: "Search Linear issues.",
          name: "mcp__linear__list_issues",
          skipReview: true,
          source: { id: "linear", description: "MCP provider linear" },
        }),
      }),
      { tool_name: "mcp__linear__list_issues" },
      reviewContext({ review }),
    );

    expect(review).not.toHaveBeenCalled();
  });

  it("reviews read-only actions that are also marked destructive", async () => {
    const review = vi.fn<ToolActionReviewer["review"]>(async () => ({
      decision: "allow",
      reason: "Conflicting annotations need review.",
      riskLevel: "medium",
      userAuthorization: "medium",
    }));

    await reviewToolAction(
      "tool-call",
      "callMcpTool",
      definition({
        approvalMode: "auto",
        resolveApprovalMetadata: async () => ({
          serverHints: { destructiveHint: true, readOnlyHint: true },
          description: "Purge the demo cache.",
          name: "mcp__demo__purge",
          source: { id: "demo", description: "MCP provider demo" },
        }),
      }),
      { tool_name: "mcp__demo__purge" },
      reviewContext({ review }),
    );

    expect(review).toHaveBeenCalledTimes(1);
  });
});
