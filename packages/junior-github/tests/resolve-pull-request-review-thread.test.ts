import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { describe, expect, it, vi } from "vitest";
import { createGitHubResolvePullRequestReviewThreadTool } from "../src/tools/resolve-pull-request-review-thread";


/** Test-only bridge for intentionally incomplete doubles. */
function asTestDouble<T>(value: unknown): T {
  return value as T;
}

const BOT_EMAIL = "123+junior[bot]@users.noreply.github.com";
const BOT_USER_ID = 123;

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
  const ctx = asTestDouble<ToolRegistrationHookContext>({
    egress: { fetch },
  });
  return {
    fetch,
    tool: createGitHubResolvePullRequestReviewThreadTool(ctx, BOT_EMAIL),
  };
}

function threadLookup(overrides?: {
  databaseId?: number;
  number?: number;
  repo?: string;
}) {
  return response({
    data: {
      node: {
        id: "PRRT_kwDOthread",
        isResolved: false,
        pullRequest: {
          author: { databaseId: overrides?.databaseId ?? BOT_USER_ID },
          number: overrides?.number ?? 1572,
          repository: { nameWithOwner: overrides?.repo ?? "getsentry/junior" },
        },
      },
    },
  });
}

describe("resolvePullRequestReviewThread", () => {
  it("verifies Junior ownership by bot user id before resolving the thread", async () => {
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
    const lookupRequest = fetch.mock.calls[0]?.[0]?.request as Request;
    await expect(lookupRequest.text()).resolves.toContain("databaseId");
    expect(fetch.mock.calls[1]?.[0]).toMatchObject({
      operation: "github.pull.review-thread.resolve:getsentry/junior",
      provider: "github",
    });
  });

  it.each([
    ["another bot id", { databaseId: 999 }],
    ["another repository", { repo: "getsentry/sentry" }],
  ])("denies %s before mutation", async (_name, overrides) => {
    const { fetch, tool } = toolContext([threadLookup(overrides)]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          threadId: "PRRT_kwDOthread",
        },
        { toolCallId: "resolve-thread" },
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message:
        "Junior can only resolve review threads on pull requests it authored.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a missing review thread as a repairable tool error", async () => {
    const { fetch, tool } = toolContext([
      response({
        data: {
          node: null,
        },
      }),
    ]);

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          threadId: "PRRT_missing",
        },
        { toolCallId: "missing-thread" },
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message: "GitHub review thread was not found.",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
