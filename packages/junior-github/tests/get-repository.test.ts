import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetRepositoryTool } from "../src/tools/get-repository";
import { createGitHubApiTestAdapter } from "./github-api-adapter";

function toolContext(responses: Array<{ body?: unknown; status?: number }>) {
  const adapter = createGitHubApiTestAdapter(responses);
  const annotations: unknown[] = [];
  const ctx = {
    annotations: {
      upsert(annotation: unknown) {
        annotations.push(annotation);
      },
    },
    egress: adapter.egress,
    resourceEvents: { canSubscribe: true },
  } as unknown as ToolRegistrationHookContext;
  return { annotations, adapter, tool: createGitHubGetRepositoryTool(ctx) };
}

describe("getRepository", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns repository metadata and a subscription hint", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { annotations, adapter, tool } = toolContext([
      {
        body: {
          default_branch: "main",
          description: "The Junior repository",
          full_name: "GetSentry/Junior",
          html_url: "https://github.com/getsentry/junior",
          private: true,
        },
      },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior" },
        { toolCallId: "get-repository" },
      ),
    ).resolves.toMatchObject({
      defaultBranch: "main",
      fullName: "GetSentry/Junior",
      subscribable: {
        identifier: "getsentry/junior",
        label: "GitHub repository GetSentry/Junior",
        namespace: "github",
        suggestedEvents: [
          "issue.opened",
          "pull_request.opened",
          "issue.comment.created",
          "issue.closed",
          "issue.reopened",
          "pull_request.checks.failed",
          "pull_request.comment.created",
          "pull_request.ready_for_review",
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
          "pull_request.review_comment.created",
          "pull_request.merged",
          "pull_request.closed_unmerged",
        ],
        supportedEvents: [
          "issue.comment.created",
          "issue.opened",
          "issue.closed",
          "issue.reopened",
          "pull_request.checks.failed",
          "pull_request.checks.recovered",
          "pull_request.comment.created",
          "pull_request.opened",
          "pull_request.ready_for_review",
          "pull_request.review.approved",
          "pull_request.review.changes_requested",
          "pull_request.review.commented",
          "pull_request.review_comment.created",
          "pull_request.merged",
          "pull_request.closed_unmerged",
        ],
        type: "repository",
      },
    });
    expect(adapter.requests()).toEqual([
      expect.objectContaining({
        operation: "github.repository.get",
        provider: "github",
      }),
    ]);
    expect(annotations).toEqual([
      {
        kind: "resource_link",
        key: "getsentry/junior",
        label: "GetSentry/Junior",
        url: "https://github.com/getsentry/junior",
      },
    ]);
  });

  it("omits the hint when GitHub webhooks are not configured", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    const { tool } = toolContext([
      {
        body: {
          default_branch: "main",
          description: null,
          full_name: "getsentry/junior",
          html_url: "https://github.com/getsentry/junior",
          private: false,
        },
      },
    ]);

    const result = await tool.execute?.(
      { repo: "getsentry/junior" },
      { toolCallId: "get-repository" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("reports a missing repository as a repairable tool error", async () => {
    const { tool } = toolContext([
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/missing" },
        { toolCallId: "missing-repository" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub repository lookup failed with HTTP 404",
      name: "PluginToolInputError",
    });
  });
});
