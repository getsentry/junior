import { describe, expect, it, vi } from "vitest";
import { createGitHubSubmitPullRequestReviewTool } from "../src/tools/submit-pull-request-review";

function toolContext(response?: Response) {
  const fetch = vi.fn(
    async () =>
      response ??
      new Response(
        JSON.stringify({
          id: 42,
          html_url:
            "https://github.com/getsentry/junior/pull/691#pullrequestreview-42",
          state: "COMMENTED",
        }),
        { status: 200 },
      ),
  );
  const ctx = { egress: { fetch } };
  return { fetch, tool: createGitHubSubmitPullRequestReviewTool(ctx) };
}

describe("submitPullRequestReview", () => {
  it("submits a REST review", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          event: "COMMENT",
          body: "No findings.",
          comments: [
            {
              path: "src/example.ts",
              body: "Keep this branch.",
              line: 12,
              side: "RIGHT",
            },
          ],
        },
        { toolCallId: "review-pr" },
      ),
    ).resolves.toEqual({
      target: "submitPullRequestReview",
      repo: "getsentry/junior",
      number: 691,
      reviewId: 42,
      state: "COMMENTED",
      url: "https://github.com/getsentry/junior/pull/691#pullrequestreview-42",
    });

    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      operation: "github.pull.review.create",
      provider: "github",
    });
    expect(call?.request.method).toBe("POST");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/pulls/691/reviews",
    );
    await expect(call?.request.clone().json()).resolves.toMatchObject({
      event: "COMMENT",
      body: "No findings.",
      comments: [
        {
          path: "src/example.ts",
          body: "Keep this branch.",
          line: 12,
          side: "RIGHT",
        },
      ],
    });
  });

  it("rejects approvals before calling GitHub", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          event: "APPROVE",
          body: "Looks good.",
        } as never,
        { toolCallId: "review-pr" },
      ),
    ).rejects.toThrow("Invalid GitHub submitPullRequestReview input.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports GitHub validation errors as repairable input", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Validation Failed" }), {
        status: 422,
      }),
    );

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          event: "REQUEST_CHANGES",
          body: "Please fix this.",
        },
        { toolCallId: "review-pr" },
      ),
    ).rejects.toThrow(
      "GitHub pull request review failed with HTTP 422: Validation Failed",
    );
  });
});
