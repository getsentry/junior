import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createGitHubResolvePullRequestReviewThreadTool } from "../src/tools/resolve-pull-request-review-thread";
import { GITHUB_SESSION_FOOTER_START } from "../src/tools/footer";

const BOT_EMAIL = "123+junior[bot]@users.noreply.github.com";

function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
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
  const ctx = { egress: { fetch } } as unknown as ToolRegistrationHookContext;
  return {
    fetch,
    tool: createGitHubResolvePullRequestReviewThreadTool(ctx, BOT_EMAIL),
  };
}

function threadLookup(overrides?: {
  author?: string;
  body?: string;
  number?: number;
  repo?: string;
}) {
  return response({
    data: {
      node: {
        id: "PRRT_kwDOthread",
        isResolved: false,
        pullRequest: {
          author: { login: overrides?.author ?? "junior[bot]" },
          body: overrides?.body ?? `${GITHUB_SESSION_FOOTER_START}\nfooter`,
          number: overrides?.number ?? 1572,
          repository: { nameWithOwner: overrides?.repo ?? "getsentry/junior" },
        },
      },
    },
  });
}

describe("resolvePullRequestReviewThread", () => {
  it("verifies Junior ownership before resolving the thread", async () => {
    const { fetch, tool } = toolContext([
      threadLookup(),
      response({
        data: {
          resolveReviewThread: {
            thread: { id: "PRRT_kwDOthread", isResolved: true },
          },
        },
      }),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 1572,
          threadId: "PRRT_kwDOthread",
        },
        { toolCallId: "resolve-thread" },
      ),
    ).resolves.toEqual({
      target: "resolvePullRequestReviewThread",
      repo: "getsentry/junior",
      number: 1572,
      threadId: "PRRT_kwDOthread",
      resolved: true,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      operation: "github.pull.review-thread.get",
      provider: "github",
    });
    expect(fetch.mock.calls[1]?.[0]).toMatchObject({
      operation: "github.pull.review-thread.resolve:getsentry/junior",
      provider: "github",
    });
  });

  it.each([
    ["another author", { author: "davidcramer" }],
    ["another PR", { number: 1573 }],
    ["another repository", { repo: "getsentry/sentry" }],
    ["no Junior footer", { body: "ordinary PR" }],
  ])("denies %s before mutation", async (_name, overrides) => {
    const { fetch, tool } = toolContext([threadLookup(overrides)]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 1572,
          threadId: "PRRT_kwDOthread",
        },
        { toolCallId: "resolve-thread" },
      ),
    ).rejects.toThrow(
      "Junior can only resolve review threads on pull requests it authored.",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
