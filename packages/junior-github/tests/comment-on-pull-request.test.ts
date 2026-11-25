import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import type { PluginWorkOwner } from "@sentry/junior-plugin-api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { juniorGitHubPullRequestRequesters } from "../src/db/schema";
import { readGitHubReviewAsked } from "../src/pull-request-review-again";
import { gitHubCommentOnPullRequestTool } from "../src/tools/comment-on-pull-request";
import { createGitHubFixture, type GitHubFixture } from "./github-db";
import { memoryState } from "./plugin-harness";

let dbFixture: GitHubFixture;

beforeAll(async () => {
  dbFixture = await createGitHubFixture();
});

afterAll(async () => {
  await dbFixture.close();
});

// The person who asked Junior for the pull request, with a linked GitHub
// account.
const requester: PluginWorkOwner = {
  kind: "person",
  identity: {
    id: "identity-requester",
    provider: "slack",
    providerSubjectId: "U123",
  },
  user: {
    email: "requester@example.com",
    id: "user-requester",
    identities: [
      {
        handle: "Requester",
        id: "identity-github",
        provider: "github",
        providerSubjectId: "1001",
      },
    ],
  },
};

function toolContext(
  response?: Response,
  // GitHub sends `in_reply_to_id: null` on the first comment of a thread.
  replyTarget: { in_reply_to_id: number | null } = { in_reply_to_id: null },
  resolveWorkOwner: () => Promise<PluginWorkOwner | undefined> = async () =>
    requester,
) {
  const fetch = vi.fn(async ({ request }: { request: Request }) => {
    if (request.method === "GET") {
      return new Response(JSON.stringify({ id: 42, ...replyTarget }), {
        status: 200,
      });
    }
    if (request.url.endsWith("/requested_reviewers")) {
      return new Response(JSON.stringify({}), { status: 201 });
    }
    return (
      response ??
      new Response(
        JSON.stringify({
          id: 88,
          html_url:
            "https://github.com/getsentry/junior/pull/691#discussion_r88",
        }),
        { status: 201 },
      )
    );
  });
  const state = memoryState();
  return {
    fetch,
    state,
    tool: bindPluginTool(gitHubCommentOnPullRequestTool, {
      db: dbFixture.db(),
      egress: { fetch },
      log: { error() {}, info() {}, warn() {} },
      resolveWorkOwner,
      state,
    }),
  };
}

/**
 * Save the requester as the first person who asked Junior about `number`.
 * Only a pull request that Junior opened has the requester's Conversation.
 */
async function seedOpener(
  number: number,
  { opened }: { opened: boolean } = { opened: true },
): Promise<void> {
  const at = new Date("2026-07-01T12:00:00.000Z");
  await dbFixture
    .db()
    .insert(juniorGitHubPullRequestRequesters)
    .values({
      conversationId: opened ? "slack:C123:1712345.0001" : null,
      createdAt: at,
      identityId: "identity-requester",
      number,
      repositoryFullName: "getsentry/junior-comment-tests",
      updatedAt: at,
    });
}

describe("commentOnPullRequest", () => {
  it("replies in an inline review thread", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          pull_request: 691,
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
      reply: {
        text: "Yes, see the new test.",
        url: "https://github.com/getsentry/junior/pull/691#discussion_r88",
      },
      url: "https://github.com/getsentry/junior/pull/691#discussion_r88",
    });

    const call = fetch.mock.calls[1]?.[0];
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

  it("replies to the first comment when in_reply_to names a reply", async () => {
    const { fetch, tool } = toolContext(undefined, { in_reply_to_id: 7 });

    await tool.execute?.(
      {
        repo: "getsentry/junior",
        pull_request: 691,
        body: "Answered.",
        in_reply_to: 42,
      },
      { toolCallId: "nested" },
    );

    expect(fetch.mock.calls[1]?.[0]?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/pulls/691/comments/7/replies",
    );
  });

  it("posts a pull request comment without in_reply_to", async () => {
    const { fetch, tool } = toolContext();

    await tool.execute?.(
      { repo: "getsentry/junior", pull_request: 691, body: "Answered." },
      { toolCallId: "comment" },
    );

    expect(fetch.mock.calls[0]?.[0]?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/691/comments",
    );
  });

  it("asks the requester for a review when the comment asks them", async () => {
    await seedOpener(701);
    const { fetch, state, tool } = toolContext();

    await expect(
      tool.execute(
        {
          repo: "getsentry/junior-comment-tests",
          pull_request: 701,
          body: "Should the gate keep the flag, or should the workflow drop the push trigger?",
          asks_requester: true,
        },
        { toolCallId: "ask" },
      ),
    ).resolves.toMatchObject({ comment_id: 88, requester_asked: true });

    const ask = fetch.mock.calls[1]?.[0];
    expect(ask?.request.method).toBe("POST");
    expect(ask?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior-comment-tests/pulls/701/requested_reviewers",
    );
    await expect(ask?.request.clone().json()).resolves.toEqual({
      reviewers: ["Requester"],
    });
    // GitHub's review request webhook reads this to say why it asks.
    await expect(
      readGitHubReviewAsked(state, {
        number: 701,
        repositoryFullName: "getsentry/junior-comment-tests",
      }),
    ).resolves.toMatchObject({ reason: "question", reviewer: "Requester" });
  });

  it.for([
    { case: "Junior did not open the pull request", number: 702, seed: false },
    {
      case: "the requester only asked Junior to update it",
      number: 705,
      seed: "updated",
    },
    {
      case: "the Turn works for someone else",
      number: 703,
      seed: true,
      workOwner: { kind: "system", id: "automation-1", name: "automation" },
    },
  ] as const)("asks nobody when $case", async ({ number, seed, ...rest }) => {
    if (seed) await seedOpener(number, { opened: seed !== "updated" });
    const { fetch, tool } = toolContext(undefined, undefined, async () =>
      "workOwner" in rest ? rest.workOwner : requester,
    );

    await expect(
      tool.execute(
        {
          repo: "getsentry/junior-comment-tests",
          pull_request: number,
          body: "Which option do you want?",
          asks_requester: true,
        },
        { toolCallId: "ask" },
      ),
    ).resolves.toMatchObject({ requester_asked: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the posted comment when the requester lookup fails", async () => {
    const { tool } = toolContext(undefined, undefined, async () => {
      throw new Error("identity store is down");
    });

    // The comment is already on GitHub, so a retry would post it twice.
    await expect(
      tool.execute(
        {
          repo: "getsentry/junior-comment-tests",
          pull_request: 704,
          body: "Which option do you want?",
          asks_requester: true,
        },
        { toolCallId: "ask" },
      ),
    ).resolves.toMatchObject({ comment_id: 88, requester_asked: false });
  });

  it("drops the question mark when GitHub does not post the comment", async () => {
    await seedOpener(706);
    const { state, tool } = toolContext(
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );

    await expect(
      tool.execute(
        {
          repo: "getsentry/junior-comment-tests",
          pull_request: 706,
          body: "Which option do you want?",
          asks_requester: true,
        },
        { toolCallId: "ask" },
      ),
    ).rejects.toThrow("HTTP 404");
    await expect(
      readGitHubReviewAsked(state, {
        number: 706,
        repositoryFullName: "getsentry/junior-comment-tests",
      }),
    ).resolves.toBeUndefined();
  });

  it("returns GitHub validation errors to the agent", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          pull_request: 691,
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
