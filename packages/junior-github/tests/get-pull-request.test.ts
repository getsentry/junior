import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetPullRequestTool } from "../src/tools/get-pull-request";
import { createGitHubApiTestAdapter } from "./github-api-adapter";


/** Test-only bridge for intentionally incomplete doubles. */
function asTestDouble<T>(value: unknown): T {
  return value as T;
}

const HEAD_SHA = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";

function toolContext(
  canSubscribe = true,
  responses: Array<{ body?: unknown; status?: number }> = [
    {
      body: {
        base: { ref: "main" },
        draft: false,
        head: { ref: "feat/resource-events", sha: HEAD_SHA },
        html_url: "https://github.com/getsentry/junior/pull/691",
        merged: false,
        number: 691,
        state: "open",
        title: "Add resource events",
      },
    },
  ],
) {
  const adapter = createGitHubApiTestAdapter(responses);
  const ctx = asTestDouble<ToolRegistrationHookContext>({
    egress: adapter.egress,
    resourceEvents: { canSubscribe },
  });
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
      headSha: HEAD_SHA,
      number: 691,
      subscribable: {
        label: "GitHub PR getsentry/junior#691",
        identifier: "getsentry/junior#691",
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

  it("omits the hint when the host cannot create subscriptions", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { tool } = toolContext(false);

    const result = await tool.execute?.(
      { repo: "getsentry/junior", number: 691 },
      { toolCallId: "get-pr-without-subscriptions" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("reports a missing pull request as a repairable tool error", async () => {
    const { tool } = toolContext(true, [
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 999999 },
        { toolCallId: "missing-pr" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub pull request lookup failed with HTTP 404",
      name: "PluginToolInputError",
    });
  });

  it("reports non-404 pull request lookup failures as runtime errors", async () => {
    const { tool } = toolContext(true, [
      { body: { message: "Internal Server Error" }, status: 500 },
    ]);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691 },
        { toolCallId: "pr-lookup-500" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub pull request lookup failed with HTTP 500",
      name: "Error",
    });
  });
});
