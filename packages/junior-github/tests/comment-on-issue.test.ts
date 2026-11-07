import { describe, expect, it, vi } from "vitest";
import { createGitHubCommentOnIssueTool } from "../src/tools/comment-on-issue";

function toolContext(response?: Response) {
  const fetch = vi.fn(
    async () =>
      response ??
      new Response(
        JSON.stringify({
          id: 99,
          html_url:
            "https://github.com/getsentry/junior/issues/2888#issuecomment-99",
        }),
        { status: 201 },
      ),
  );
  return { fetch, tool: createGitHubCommentOnIssueTool({ fetch }) };
}

describe("commentOnIssue", () => {
  it("posts an issue comment", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 2888, body: "Concerns below." },
        { toolCallId: "comment" },
      ),
    ).resolves.toEqual({
      target: "commentOnIssue",
      repo: "getsentry/junior",
      number: 2888,
      comment_id: 99,
      url: "https://github.com/getsentry/junior/issues/2888#issuecomment-99",
    });

    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      operation: "github.issue.comment.create",
      provider: "github",
    });
    expect(call?.request.method).toBe("POST");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/2888/comments",
    );
    await expect(call?.request.clone().json()).resolves.toEqual({
      body: "Concerns below.",
    });
  });

  it("returns GitHub validation errors to the agent", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 2888, body: "Concerns below." },
        { toolCallId: "missing" },
      ),
    ).rejects.toThrow("GitHub issue comment failed with HTTP 404: Not Found");
  });
});
