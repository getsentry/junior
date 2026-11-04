import { describe, expect, it, vi } from "vitest";
import { createGitHubCommentOnPullRequestTool } from "../src/tools/comment-on-pull-request";

function toolContext(response?: Response) {
  const fetch = vi.fn(
    async () =>
      response ??
      new Response(
        JSON.stringify({
          id: 88,
          html_url:
            "https://github.com/getsentry/junior/pull/691#discussion_r88",
        }),
        { status: 201 },
      ),
  );
  return { fetch, tool: createGitHubCommentOnPullRequestTool({ fetch }) };
}

describe("commentOnPullRequest", () => {
  it("replies in an inline review thread", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          body: "Yes, see the new test.",
          in_reply_to: 42,
        },
        { toolCallId: "reply" },
      ),
    ).resolves.toEqual({
      target: "commentOnPullRequest",
      repo: "getsentry/junior",
      number: 691,
      comment_id: 88,
      url: "https://github.com/getsentry/junior/pull/691#discussion_r88",
    });

    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      operation: "github.pull.comment.create",
      provider: "github",
    });
    expect(call?.request.method).toBe("POST");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/pulls/691/comments/42/replies",
    );
    await expect(call?.request.clone().json()).resolves.toEqual({
      body: "Yes, see the new test.",
    });
  });

  it("posts a pull request comment without in_reply_to", async () => {
    const { fetch, tool } = toolContext();

    await tool.execute?.(
      { repo: "getsentry/junior", number: 691, body: "Answered." },
      { toolCallId: "comment" },
    );

    expect(fetch.mock.calls[0]?.[0]?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/691/comments",
    );
  });

  it("returns GitHub validation errors to the agent", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          body: "Answered.",
          in_reply_to: 42,
        },
        { toolCallId: "missing" },
      ),
    ).rejects.toThrow(
      "GitHub pull request comment failed with HTTP 404: Not Found",
    );
  });
});
