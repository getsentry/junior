import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { describe, expect, it, vi } from "vitest";
import { gitHubCommentOnIssueTool } from "../src/tools/comment-on-issue";
import { createGitHubUpdateIssueCommentTool } from "../src/tools/update-issue-comment";

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
  return {
    fetch,
    tool: bindPluginTool(gitHubCommentOnIssueTool, { egress: { fetch } }),
  };
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

const BOT_EMAIL = "123+junior[bot]@users.noreply.github.com";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function updateContext(responses: Response[]) {
  const pending = [...responses];
  const fetch = vi.fn(async () => {
    const next = pending.shift();
    if (!next) throw new Error("unexpected GitHub request");
    return next;
  });
  return {
    fetch,
    tool: bindPluginTool(createGitHubUpdateIssueCommentTool(BOT_EMAIL), {
      egress: { fetch },
    }),
  };
}

describe("updateIssueComment", () => {
  it("replaces the body of a comment the bot posted", async () => {
    const { fetch, tool } = updateContext([
      json({ user: { id: 123 } }),
      json({
        id: 99,
        html_url:
          "https://github.com/getsentry/junior/issues/2888#issuecomment-99",
      }),
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", comment_id: 99, body: "- [x] Reproduced" },
        { toolCallId: "update" },
      ),
    ).resolves.toEqual({
      target: "updateIssueComment",
      repo: "getsentry/junior",
      comment_id: 99,
      url: "https://github.com/getsentry/junior/issues/2888#issuecomment-99",
    });

    const update = fetch.mock.calls[1]?.[0];
    expect(update).toMatchObject({
      operation: "github.issue.comment.update",
      provider: "github",
    });
    expect(update?.request.method).toBe("PATCH");
    expect(update?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/comments/99",
    );
    await expect(update?.request.clone().json()).resolves.toEqual({
      body: "- [x] Reproduced",
    });
  });

  it("refuses comments by other users without writing", async () => {
    const { fetch, tool } = updateContext([json({ user: { id: 456 } })]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", comment_id: 99, body: "Edited." },
        { toolCallId: "other" },
      ),
    ).rejects.toThrow("This bot can only edit issue comments it posted.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
