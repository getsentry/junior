import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetDeploymentTool } from "../src/tools/get-deployment";

const ORIGINAL_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const COMMIT_SHA = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";

function toolContext(responses: unknown[]) {
  const fetch = vi.fn(async () => {
    const body = responses.shift();
    return new Response(JSON.stringify(body), { status: 200 });
  });
  const ctx = {
    egress: { fetch },
  } as unknown as ToolRegistrationHookContext;
  return { fetch, tool: createGitHubGetDeploymentTool(ctx) };
}

describe("getDeployment", () => {
  afterEach(() => {
    if (ORIGINAL_WEBHOOK_SECRET === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
    }
  });

  it("returns deployment metadata, its latest status, and a subscription hint", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const { fetch, tool } = toolContext([
      [
        {
          created_at: "2026-07-28T05:17:14Z",
          creator: { login: "vercel[bot]" },
          description: null,
          environment: "Production",
          id: 5_634_510_476,
          ref: COMMIT_SHA,
          sha: COMMIT_SHA,
          updated_at: "2026-07-28T05:17:14Z",
        },
      ],
      [
        {
          created_at: "2026-07-28T05:17:14Z",
          creator: { login: "vercel[bot]" },
          description: "Deployment has failed",
          environment_url: "https://junior-prod.example",
          id: 16_022_370_846,
          log_url: "https://junior-prod.example/logs",
          state: "failure",
        },
      ],
    ]);

    await expect(
      tool.execute?.(
        {
          commitSha: COMMIT_SHA.toUpperCase(),
          environment: "Production",
          repo: "GetSentry/Junior-Prod",
        },
        { toolCallId: "get-deployment" },
      ),
    ).resolves.toMatchObject({
      commitSha: COMMIT_SHA,
      deployment: {
        environment: "Production",
        id: 5_634_510_476,
        latestStatus: {
          description: "Deployment has failed",
          state: "failure",
        },
      },
      subscribable: {
        resourceRef: `github:deployment-source:getsentry/junior-prod:production:${COMMIT_SHA}`,
        suggestedEvents: [
          "deployment.succeeded",
          "deployment.failed",
          "deployment.error",
        ],
        type: "deployment_source",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const deploymentsRequest = fetch.mock.calls[0]?.[0].request as Request;
    expect(deploymentsRequest.url).toContain(`sha=${COMMIT_SHA}`);
    expect(deploymentsRequest.url).toContain("environment=Production");
    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      operation: "github.deployment.list",
      provider: "github",
    });
    expect(fetch.mock.calls[1]?.[0]).toMatchObject({
      operation: "github.deployment-status.list",
      provider: "github",
    });
  });

  it("returns a subscribable source before GitHub creates the deployment", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
    const { fetch, tool } = toolContext([[]]);

    await expect(
      tool.execute?.(
        {
          commitSha: COMMIT_SHA,
          environment: "Preview",
          repo: "getsentry/junior-prod",
        },
        { toolCallId: "watch-deployment" },
      ),
    ).resolves.toMatchObject({
      deployment: null,
      subscribable: {
        resourceRef: `github:deployment-source:getsentry/junior-prod:preview:${COMMIT_SHA}`,
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
