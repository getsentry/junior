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

/** GitHub replies that show the comment is on a PR that `authorId` opened. */
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
  return [response(parentUrl), response({ user: { id: authorId } })];
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
          status: "addressed",
        },
        { toolCallId: "mark-addressed" },
      ),
    ).resolves.toEqual({
      target: "updatePullRequestFeedback",
      repo: "getsentry/junior",
      comment_id: 55,
      status: "addressed",
      reaction_id: 91,
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    const commentRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(commentRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55",
    );
    const pullRequest = fetch.mock.calls[1]?.[0]?.request as Request;
    expect(pullRequest.url).toContain("/repos/getsentry/junior/pulls/7");
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
        status: "declined",
      },
      { toolCallId: "mark-declined" },
    );

    const commentRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(commentRequest.url).toContain(
      "/repos/getsentry/junior/pulls/comments/77",
    );
    const listRequest = fetch.mock.calls[2]?.[0]?.request as Request;
    expect(listRequest.url).toContain(
      "/repos/getsentry/junior/pulls/comments/77/reactions",
    );
  });

  // The model supplies the comment, so both cases come from untrusted input.
  it.each([
    {
      name: "a pull request that the bot did not author",
      commentKind: "review" as const,
      responses: pullRequestLookup("review", HUMAN_USER_ID),
    },
    {
      name: "a plain issue",
      commentKind: "conversation" as const,
      responses: [
        response({
          issue_url: "https://api.github.com/repos/getsentry/junior/issues/8",
        }),
        response({ message: "Not Found" }, 404),
      ],
    },
  ])(
    "refuses feedback on a comment on $name",
    async ({ commentKind, responses }) => {
      const { fetch, tool } = toolContext(responses);

      await expect(
        tool.execute?.(
          {
            repo: "getsentry/junior",
            comment_kind: commentKind,
            comment_id: 77,
            status: "addressed",
          },
          { toolCallId: "not-owned" },
        ),
      ).rejects.toThrow(
        "only set feedback status on comments on pull requests it authored",
      );

      // Only the two ownership reads ran. No reaction was listed or written.
      expect(fetch).toHaveBeenCalledTimes(2);
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
          status: "addressed",
        },
        { toolCallId: "mark-addressed" },
      ),
    ).resolves.toMatchObject({ status: "addressed", reaction_id: 3 });

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
          status: "addressed",
        },
        { toolCallId: "missing-eyes" },
      ),
    ).resolves.toMatchObject({ status: "addressed", reaction_id: 3 });

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
          status: "addressed",
        },
        { toolCallId: "already-addressed" },
      ),
    ).resolves.toMatchObject({ status: "addressed", reaction_id: 9 });

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("replaces Junior's prior status reaction on a review body through GraphQL", async () => {
    const { fetch, tool } = toolContext([
      response({ user: { id: BOT_USER_ID } }),
      response({ id: 303, node_id: "PRR_303" }),
      response({
        data: {
          node: {
            reactionGroups: [
              { content: "EYES", viewerHasReacted: true },
              { content: "HEART", viewerHasReacted: true },
              { content: "THUMBS_UP", viewerHasReacted: false },
            ],
          },
        },
      }),
      response({
        data: { removeReaction: { reaction: { content: "EYES" } } },
      }),
      response({
        data: { addReaction: { reaction: { databaseId: 404 } } },
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
      reaction_id: 404,
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

  it.each([
    {
      name: "without a pull request number",
      input: {},
      responses: [],
      error: "pull_request is required",
      calls: 0,
    },
    {
      name: "on a pull request that the bot did not author",
      input: { pull_request: 7 },
      responses: [response({ user: { id: HUMAN_USER_ID } })],
      error:
        "only set feedback status on comments on pull requests it authored",
      calls: 1,
    },
  ])(
    "refuses review body feedback $name",
    async ({ calls, error, input, responses }) => {
      const { fetch, tool } = toolContext(responses);

      await expect(
        tool.execute?.(
          {
            repo: "getsentry/junior",
            comment_kind: "review_body",
            comment_id: 303,
            status: "declined",
            ...input,
          },
          { toolCallId: "review-body-refused" },
        ),
      ).rejects.toThrow(error);

      expect(fetch).toHaveBeenCalledTimes(calls);
    },
  );

  it("does not expose the webhook-owned reviewing state", async () => {
    const { fetch, tool } = toolContext([]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          comment_kind: "conversation",
          comment_id: 55,
          status: "reviewing",
        },
        { toolCallId: "mark-reviewing" },
      ),
    ).rejects.toThrow("Invalid GitHub updatePullRequestFeedback input");

    expect(fetch).not.toHaveBeenCalled();
  });
});
