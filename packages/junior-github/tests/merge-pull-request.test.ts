import { describe, expect, it, vi } from "vitest";
import { createGitHubMergePullRequestTool } from "../src/tools/merge-pull-request";

const BOT_ID = 12345;
const BOT_EMAIL = `${BOT_ID}+sentry-junior[bot]@users.noreply.github.com`;
const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const bot = { id: BOT_ID, type: "Bot", login: "sentry-junior[bot]" };
const alice = { id: 1, type: "User", login: "alice" };
const bob = { id: 2, type: "User", login: "bob" };

interface Scenario {
  author?: typeof bot;
  commitCount?: number;
  commits?: unknown[];
  headSha?: string;
  mergeableState?: string;
  permission?: string;
  reviews?: unknown[];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function toolContext(
  scenario: Scenario = {},
  repositories = ["getsentry/junior"],
) {
  const fetch = vi.fn(async ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/collaborators/alice/permission")) {
      return json({ permission: scenario.permission ?? "write" });
    }
    if (path.endsWith("/pulls/7/reviews")) return json(scenario.reviews ?? []);
    if (path.endsWith("/pulls/7/commits")) {
      return json(
        scenario.commits ?? [
          {
            author: { id: bob.id },
            committer: { id: bob.id },
            commit: {
              author: { email: "bob@example.com" },
              committer: { email: "bob@example.com" },
            },
          },
        ],
      );
    }
    if (path.endsWith("/pulls/7/merge")) {
      return json({ merged: true, sha: "c".repeat(40) });
    }
    if (path.endsWith("/pulls/7")) {
      return json({
        commits: scenario.commitCount ?? 1,
        draft: false,
        head: { sha: scenario.headSha ?? HEAD },
        mergeable_state: scenario.mergeableState ?? "clean",
        merged: false,
        state: "open",
        user: scenario.author ?? bot,
      });
    }
    return json({ message: "Not Found" }, 404);
  });
  const tool = createGitHubMergePullRequestTool(
    {
      actor: { type: "user", userId: "U123" } as never,
      egress: { fetch } as never,
      log: { warn: vi.fn() } as never,
      users: {
        resolveActor: async () =>
          ({
            identity: {},
            user: { identities: [{ provider: "github", handle: "alice" }] },
          }) as never,
      },
    },
    { botEmail: BOT_EMAIL, repositories: new Set(repositories) },
  );
  const merge = (headSha = HEAD) =>
    tool.execute?.(
      { repo: "getsentry/junior", number: 7, headSha },
      { toolCallId: "merge-pr" },
    );
  return { fetch, merge };
}

function mergeCall(fetch: ReturnType<typeof toolContext>["fetch"]) {
  return fetch.mock.calls.find(([call]) =>
    call.request.url.endsWith("/merge"),
  )?.[0];
}

describe("mergePullRequest", () => {
  it("merges a Junior pull request that a person approved at the checked head", async () => {
    const { fetch, merge } = toolContext({
      reviews: [{ user: alice, state: "APPROVED", commit_id: HEAD }],
    });

    await expect(merge()).resolves.toMatchObject({
      target: "mergePullRequest",
      merged: true,
    });
    const call = mergeCall(fetch);
    expect(call).toMatchObject({ operation: "github.pull.merge" });
    expect(call?.request.method).toBe("PUT");
    await expect(call?.request.clone().json()).resolves.toEqual({
      merge_method: "squash",
      sha: HEAD,
    });
  });

  it("refuses a Junior pull request whose approval is for an older head", async () => {
    const { fetch, merge } = toolContext({
      reviews: [{ user: alice, state: "APPROVED", commit_id: OLD_HEAD }],
    });

    await expect(merge()).rejects.toThrow("a person must approve");
    expect(mergeCall(fetch)).toBeUndefined();
  });

  it("merges a person's pull request after Junior reviewed the checked head", async () => {
    const { merge } = toolContext({
      author: bob,
      reviews: [{ user: bot, state: "COMMENTED", commit_id: HEAD }],
    });

    await expect(merge()).resolves.toMatchObject({ merged: true });
  });

  it("refuses a person's pull request that contains a Junior commit", async () => {
    const { fetch, merge } = toolContext({
      author: bob,
      commits: [
        {
          author: null,
          committer: null,
          commit: {
            author: { email: BOT_EMAIL },
            committer: { email: BOT_EMAIL },
          },
        },
      ],
      reviews: [{ user: bot, state: "COMMENTED", commit_id: HEAD }],
    });

    await expect(merge()).rejects.toThrow("You wrote commits");
    expect(mergeCall(fetch)).toBeUndefined();
  });

  it("refuses a person's pull request with more commits than GitHub lists", async () => {
    const { fetch, merge } = toolContext({
      author: bob,
      commitCount: 251,
      reviews: [{ user: bot, state: "COMMENTED", commit_id: HEAD }],
    });

    await expect(merge()).rejects.toThrow("only 1 could be checked");
    expect(mergeCall(fetch)).toBeUndefined();
  });

  it("refuses when a reviewer requested changes or checks are not clean", async () => {
    await expect(
      toolContext({
        reviews: [
          { user: alice, state: "APPROVED", commit_id: HEAD },
          { user: bob, state: "CHANGES_REQUESTED", commit_id: HEAD },
        ],
      }).merge(),
    ).rejects.toThrow("requested changes");
    await expect(
      toolContext({
        mergeableState: "unstable",
        reviews: [{ user: alice, state: "APPROVED", commit_id: HEAD }],
      }).merge(),
    ).rejects.toThrow("`unstable`");
  });

  it("refuses a changed head, a read-only requester, and an unlisted repository", async () => {
    const approved = [{ user: alice, state: "APPROVED", commit_id: HEAD }];
    await expect(
      toolContext({ reviews: approved }).merge(OLD_HEAD),
    ).rejects.toThrow("not the checked commit");
    await expect(
      toolContext({ permission: "read", reviews: approved }).merge(),
    ).rejects.toThrow("write access");

    const unlisted = toolContext({ reviews: approved }, ["getsentry/other"]);
    await expect(unlisted.merge()).rejects.toThrow(
      "Merging is not enabled for getsentry/junior",
    );
    expect(unlisted.fetch).not.toHaveBeenCalled();
  });
});
