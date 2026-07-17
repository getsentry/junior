import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetPullRequestTool } from "../src/tools/get-pull-request";

const ORIGINAL_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function toolContext() {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          base: { ref: "main" },
          draft: false,
          head: { ref: "feat/resource-events" },
          html_url: "https://github.com/getsentry/junior/pull/691",
          merged: false,
          number: 691,
          state: "open",
          title: "Add resource events",
        }),
        { status: 200 },
      ),
  );
  const ctx = {
    egress: { fetch },
  } as unknown as ToolRegistrationHookContext;
  return { fetch, tool: createGitHubGetPullRequestTool(ctx) };
}

describe("getPullRequest", () => {
  afterEach(() => {
    if (ORIGINAL_WEBHOOK_SECRET === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
    }
  });

  it("returns a subscribable hint for an existing pull request", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691 },
        { toolCallId: "get-pr" },
      ),
    ).resolves.toMatchObject({
      number: 691,
      subscribable: {
        label: "GitHub PR getsentry/junior#691",
        resourceRef: "github:pull_request:getsentry/junior#691",
        type: "pull_request",
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "github.pull.get",
        provider: "github",
      }),
    );
  });

  it("omits the hint when GitHub webhooks are not configured", async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    const { tool } = toolContext();

    const result = await tool.execute?.(
      { repo: "getsentry/junior", number: 691 },
      { toolCallId: "get-pr" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });
});
