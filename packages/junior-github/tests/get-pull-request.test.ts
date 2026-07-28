import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetPullRequestTool } from "../src/tools/get-pull-request";
import { createGitHubApiTestAdapter } from "./github-api-adapter";

function toolContext() {
  const adapter = createGitHubApiTestAdapter([
    {
      body: {
        base: { ref: "main" },
        draft: false,
        head: { ref: "feat/resource-events" },
        html_url: "https://github.com/getsentry/junior/pull/691",
        merged: false,
        number: 691,
        state: "open",
        title: "Add resource events",
      },
    },
  ]);
  const ctx = {
    egress: adapter.egress,
  } as unknown as ToolRegistrationHookContext;
  return { adapter, tool: createGitHubGetPullRequestTool(ctx) };
}

describe("getPullRequest", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a subscribable hint for an existing pull request", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { adapter, tool } = toolContext();

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
    expect(adapter.requests()).toEqual([
      expect.objectContaining({
        operation: "github.pull.get",
        provider: "github",
      }),
    ]);
  });

  it("omits the hint when GitHub webhooks are not configured", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "");
    const { tool } = toolContext();

    const result = await tool.execute?.(
      { repo: "getsentry/junior", number: 691 },
      { toolCallId: "get-pr" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });
});
