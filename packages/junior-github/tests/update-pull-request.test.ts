import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubUpdatePullRequestTool } from "../src/tools/update-pull-request";

const ORIGINAL_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function toolContext(response?: Response) {
  const fetch = vi.fn(
    async () =>
      response ??
      new Response(
        JSON.stringify({
          base: { ref: "release" },
          body: "Updated body",
          draft: false,
          html_url: "https://github.com/getsentry/junior/pull/691",
          number: 691,
          state: "open",
          title: "Updated title",
        }),
        { status: 200 },
      ),
  );
  const ctx = {
    actor: {
      platform: "slack",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "david",
    },
    conversationId: "slack:C123:123.456",
    egress: { fetch },
    slack: {
      conversationLink: { url: "https://example.com/session" },
    },
  } as unknown as ToolRegistrationHookContext;
  return { fetch, tool: createGitHubUpdatePullRequestTool(ctx) };
}

describe("updatePullRequest", () => {
  afterEach(() => {
    if (ORIGINAL_WEBHOOK_SECRET === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
    }
  });

  it("updates mutable pull request fields and preserves Junior-owned body metadata", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          title: "Updated title",
          body: "Updated body",
          base: "release",
          state: "open",
        },
        { toolCallId: "update-pr" },
      ),
    ).resolves.toMatchObject({
      base: "release",
      number: 691,
      state: "open",
      target: "updatePullRequest",
      title: "Updated title",
      subscribable: {
        resourceRef: "github:pull_request:getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/pull/691",
    });

    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      operation: "github.pull.update",
      provider: "github",
    });
    expect(call?.request.method).toBe("PATCH");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/pulls/691",
    );
    await expect(call?.request.clone().json()).resolves.toMatchObject({
      base: "release",
      state: "open",
      title: "Updated title",
      body: expect.stringContaining("Updated body"),
    });
    const body = (await call?.request.clone().json()) as { body: string };
    expect(body.body).toContain("Requested by **David Cramer** via Junior.");
    expect(body.body).toContain(
      "[View Junior Session](https://example.com/session)",
    );
  });

  it.each([
    { repo: "getsentry/junior", number: 691 },
    { repo: "getsentry/junior", number: 691, title: "   " },
    { repo: "getsentry/junior", number: 691, base: "" },
  ])("rejects invalid updates before calling GitHub", async (input) => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(input, { toolCallId: "update-pr" }),
    ).rejects.toThrow("Invalid GitHub updatePullRequest input.");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("includes GitHub's error message when the update fails", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Validation Failed" }), {
        status: 422,
      }),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691, base: "missing" },
        { toolCallId: "update-pr" },
      ),
    ).rejects.toThrow(
      "GitHub pull request update failed with HTTP 422: Validation Failed",
    );
  });
});
