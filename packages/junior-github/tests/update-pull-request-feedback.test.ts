import { describe, expect, it, vi } from "vitest";
import { createGitHubUpdatePullRequestFeedbackTool } from "../src/tools/update-pull-request-feedback";

const BOT_EMAIL = "123+junior[bot]@users.noreply.github.com";
const BOT_USER_ID = 123;
const HUMAN_USER_ID = 456;

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** GitHub replies that show PR 7 is by `authorId` and the comment is on it. */
function pullRequestLookup(
  commentKind: "conversation" | "review",
  authorId = BOT_USER_ID,
) {
  const parentUrl =
    commentKind === "conversation"
      ? { issue_url: "https://api.github.com/repos/getsentry/junior/issues/7" }
      : {
          pull_request_url:
            "https://api.github.com/repos/getsentry/junior/pulls/7",
        };
  return [response({ user: { id: authorId } }), response(parentUrl)];
}

function toolContext(responses: Response[]) {
  const pending = [...responses];
  const fetch = vi.fn(async () => {
    const next = pending.shift();
    if (!next) throw new Error("unexpected GitHub request");
    return next;
  });
  return {
    fetch,
    tool: createGitHubUpdatePullRequestFeedbackTool(
      { egress: { fetch } },
      BOT_EMAIL,
    ),
  };
}

describe("updatePullRequestFeedback", () => {
  it("is directly available to event turns", () => {
    expect(toolContext([]).tool.exposure).toBe("direct");
  });

  it("adds the addressed reaction for a fresh conversation comment", async () => {
    const { fetch, tool } = toolContext([
      ...pullRequestLookup("conversation"),
      response([]),
      response({ id: 91, content: "+1", user: { id: BOT_USER_ID } }, 201),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "conversation",
          comment_id: 55,
          pull_request: 7,
          status: "addressed",
        },
        { toolCallId: "mark-addressed" },
      ),
    ).resolves.toEqual({
      target: "updatePullRequestFeedback",
      repo: "getsentry/junior",
      comment_id: 55,
      status: "addressed",
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    const pullRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(pullRequest.url).toContain("/repos/getsentry/junior/pulls/7");
    const commentRequest = fetch.mock.calls[1]?.[0]?.request as Request;
    expect(commentRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55",
    );
    expect(fetch.mock.calls[2]?.[0]).toMatchObject({
      operation: "github.pull.comment-reaction.list",
    });
    const listRequest = fetch.mock.calls[2]?.[0]?.request as Request;
    expect(listRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55/reactions",
    );
    const createRequest = fetch.mock.calls[3]?.[0]?.request as Request;
    expect(createRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55/reactions",
    );
    await expect(createRequest.text()).resolves.toBe(
      JSON.stringify({ content: "+1" }),
    );
  });

  it("uses the pulls comments path for inline review comments", async () => {
    const { fetch, tool } = toolContext([
      ...pullRequestLookup("review"),
      response([]),
      response({ id: 12, content: "-1", user: { id: BOT_USER_ID } }, 201),
    ]);

    await tool.execute?.(
      {
        repo: "getsentry/junior",
        comment_kind: "review",
        comment_id: 77,
        pull_request: 7,
        status: "declined",
      },
      { toolCallId: "mark-declined" },
    );

    const commentRequest = fetch.mock.calls[1]?.[0]?.request as Request;
    expect(commentRequest.url).toContain(
      "/repos/getsentry/junior/pulls/comments/77",
    );
    const listRequest = fetch.mock.calls[2]?.[0]?.request as Request;
    expect(listRequest.url).toContain(
      "/repos/getsentry/junior/pulls/comments/77/reactions",
    );
  });

  // The model supplies the target, so every case comes from untrusted input.
  // Each comment kind gets the same checks.
  it.each([
    {
      name: "a review comment on a pull request that the bot did not author",
      input: { comment_kind: "review" },
      responses: pullRequestLookup("review", HUMAN_USER_ID).slice(0, 1),
      error:
        "only set feedback status on comments on pull requests it authored",
      calls: 1,
    },
    {
      name: "a review body on a pull request that the bot did not author",
      input: { comment_kind: "review_body" },
      responses: [response({ user: { id: HUMAN_USER_ID } })],
      error:
        "only set feedback status on comments on pull requests it authored",
      calls: 1,
    },
    {
      name: "a plain issue",
      input: { comment_kind: "conversation" },
      responses: [response({ message: "Not Found" }, 404)],
      error:
        "only set feedback status on comments on pull requests it authored",
      calls: 1,
    },
    {
      name: "a comment on another pull request",
      input: { comment_kind: "conversation" },
      responses: [
        response({ user: { id: BOT_USER_ID } }),
        response({
          issue_url: "https://api.github.com/repos/getsentry/junior/issues/8",
        }),
      ],
      error: "GitHub comment 77 is not on pull request 7",
      calls: 2,
    },
    {
      name: "a missing pull request number",
      input: { comment_kind: "review_body", pull_request: undefined },
      responses: [],
      error: "Invalid GitHub updatePullRequestFeedback input",
      calls: 0,
    },
  ])(
    "refuses feedback on $name",
    async ({ calls, error, input, responses }) => {
      const { fetch, tool } = toolContext(responses);

      await expect(
        tool.execute?.(
          {
            repo: "getsentry/junior",
            comment_id: 77,
            pull_request: 7,
            status: "addressed",
            ...input,
          },
          { toolCallId: "refused" },
        ),
      ).rejects.toThrow(error);

      // No reaction was listed or written.
      expect(fetch).toHaveBeenCalledTimes(calls);
    },
  );

  it("replaces Junior's prior status reaction without touching a human reaction", async () => {
    const { fetch, tool } = toolContext([
      ...pullRequestLookup("conversation"),
      response([
        { id: 1, content: "eyes", user: { id: BOT_USER_ID } },
        { id: 2, content: "heart", user: { id: HUMAN_USER_ID } },
      ]),
      response(undefined, 204),
      response({ id: 3, content: "+1", user: { id: BOT_USER_ID } }, 201),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "conversation",
          comment_id: 55,
          pull_request: 7,
          status: "addressed",
        },
        { toolCallId: "mark-addressed" },
      ),
    ).resolves.toMatchObject({ status: "addressed" });

    expect(fetch).toHaveBeenCalledTimes(5);
    const deleteRequest = fetch.mock.calls[3]?.[0]?.request as Request;
    expect(deleteRequest.method).toBe("DELETE");
    expect(deleteRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55/reactions/1",
    );
  });

  it("continues when a stale status reaction disappears before deletion", async () => {
    const { fetch, tool } = toolContext([
      ...pullRequestLookup("conversation"),
      response([
        { id: 1, content: "eyes", user: { id: BOT_USER_ID } },
        { id: 2, content: "rocket", user: { id: BOT_USER_ID } },
      ]),
      response({ message: "Not Found" }, 404),
      response({ id: 3, content: "+1", user: { id: BOT_USER_ID } }, 201),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "conversation",
          comment_id: 55,
          pull_request: 7,
          status: "addressed",
        },
        { toolCallId: "missing-eyes" },
      ),
    ).resolves.toMatchObject({ status: "addressed" });

    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it("is idempotent when the outcome reaction already exists", async () => {
    const { fetch, tool } = toolContext([
      ...pullRequestLookup("conversation"),
      response([{ id: 9, content: "+1", user: { id: BOT_USER_ID } }]),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "conversation",
          comment_id: 55,
          pull_request: 7,
          status: "addressed",
        },
        { toolCallId: "already-addressed" },
      ),
    ).resolves.toMatchObject({ status: "addressed" });

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("replaces Junior's prior status reaction on a review body through GraphQL", async () => {
    const bot = { databaseId: BOT_USER_ID };
    const { fetch, tool } = toolContext([
      response({ user: { id: BOT_USER_ID } }),
      response({ id: 303, node_id: "PRR_303" }),
      response({
        data: {
          node: {
            // A human reactor is not a Bot, so it has no databaseId here.
            reactionGroups: [
              { content: "EYES", reactors: { nodes: [bot] } },
              { content: "HEART", reactors: { nodes: [bot] } },
              { content: "THUMBS_UP", reactors: { nodes: [{}] } },
            ],
          },
        },
      }),
      response({
        data: { removeReaction: { reaction: { content: "EYES" } } },
      }),
      response({
        data: { addReaction: { reaction: { content: "THUMBS_UP" } } },
      }),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "review_body",
          comment_id: 303,
          pull_request: 7,
          status: "addressed",
        },
        { toolCallId: "mark-review-body" },
      ),
    ).resolves.toEqual({
      target: "updatePullRequestFeedback",
      repo: "getsentry/junior",
      comment_id: 303,
      status: "addressed",
    });

    expect(fetch).toHaveBeenCalledTimes(5);
    const pullRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(pullRequest.url).toContain("/repos/getsentry/junior/pulls/7");
    const reviewRequest = fetch.mock.calls[1]?.[0]?.request as Request;
    expect(reviewRequest.url).toContain(
      "/repos/getsentry/junior/pulls/7/reviews/303",
    );
    // Only Junior's EYES state reaction is removed, not its HEART.
    expect(fetch.mock.calls[3]?.[0]).toMatchObject({
      operation: "github.pull.review-reaction.update:getsentry/junior",
    });
    const removeRequest = fetch.mock.calls[3]?.[0]?.request as Request;
    await expect(removeRequest.json()).resolves.toMatchObject({
      operationName: "RemoveReviewReaction",
      variables: { content: "EYES", subjectId: "PRR_303" },
    });
    const addRequest = fetch.mock.calls[4]?.[0]?.request as Request;
    await expect(addRequest.json()).resolves.toMatchObject({
      operationName: "AddReviewReaction",
      variables: { content: "THUMBS_UP", subjectId: "PRR_303" },
    });
  });

  it("does not expose the webhook-owned reviewing state", async () => {
    const { fetch, tool } = toolContext([]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "conversation",
          comment_id: 55,
          pull_request: 7,
          status: "reviewing",
        },
        { toolCallId: "mark-reviewing" },
      ),
    ).rejects.toThrow("Invalid GitHub updatePullRequestFeedback input");

    expect(fetch).not.toHaveBeenCalled();
  });
});
