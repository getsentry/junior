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
  it("adds the eyes reaction for a fresh conversation comment", async () => {
    const { fetch, tool } = toolContext([
      response([]),
      response({ id: 91, content: "eyes", user: { id: BOT_USER_ID } }, 201),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          commentKind: "conversation",
          commentId: 55,
          status: "reviewing",
        },
        { toolCallId: "mark-reviewing" },
      ),
    ).resolves.toEqual({
      target: "updatePullRequestFeedback",
      repo: "getsentry/junior",
      commentId: 55,
      status: "reviewing",
      reactionId: 91,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      operation: "github.pull.comment-reaction.list",
    });
    const listRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(listRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55/reactions",
    );
    const createRequest = fetch.mock.calls[1]?.[0]?.request as Request;
    expect(createRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55/reactions",
    );
    await expect(createRequest.text()).resolves.toBe(
      JSON.stringify({ content: "eyes" }),
    );
  });

  it("uses the pulls comments path for inline review comments", async () => {
    const { fetch, tool } = toolContext([
      response([]),
      response({ id: 12, content: "-1", user: { id: BOT_USER_ID } }, 201),
    ]);

    await tool.execute?.(
      {
        repo: "getsentry/junior",
        commentKind: "review",
        commentId: 77,
        status: "declined",
      },
      { toolCallId: "mark-declined" },
    );

    const listRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(listRequest.url).toContain(
      "/repos/getsentry/junior/pulls/comments/77/reactions",
    );
  });

  it("replaces Junior's prior status reaction without touching a human reaction", async () => {
    const { fetch, tool } = toolContext([
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
          commentKind: "conversation",
          commentId: 55,
          status: "addressed",
        },
        { toolCallId: "mark-addressed" },
      ),
    ).resolves.toMatchObject({ status: "addressed", reactionId: 3 });

    expect(fetch).toHaveBeenCalledTimes(3);
    const deleteRequest = fetch.mock.calls[1]?.[0]?.request as Request;
    expect(deleteRequest.method).toBe("DELETE");
    expect(deleteRequest.url).toContain(
      "/repos/getsentry/junior/issues/comments/55/reactions/1",
    );
  });

  it("is idempotent when the status reaction already exists", async () => {
    const { fetch, tool } = toolContext([
      response([{ id: 9, content: "eyes", user: { id: BOT_USER_ID } }]),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          commentKind: "conversation",
          commentId: 55,
          status: "reviewing",
        },
        { toolCallId: "already-reviewing" },
      ),
    ).resolves.toMatchObject({ status: "reviewing", reactionId: 9 });

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
