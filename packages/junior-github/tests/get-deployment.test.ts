import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubGetDeploymentTool } from "../src/tools/get-deployment";
import { createGitHubApiTestAdapter } from "./github-api-adapter";
import { castThroughUnknown } from "@sentry/junior-plugin-api";

const COMMIT_SHA = "c610b5d6a88c9da5d65627a1cdb3829b05c14f75";

function toolContext(responses: Array<{ body?: unknown; status?: number }>) {
  const adapter = createGitHubApiTestAdapter(responses);
  const ctx = castThroughUnknown<ToolRegistrationHookContext>({
    egress: adapter.egress,
    resourceEvents: { canSubscribe: true },
  });
  return { adapter, tool: createGitHubGetDeploymentTool(ctx) };
}

describe("getDeployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns deployment metadata, its latest status, and a subscription hint", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { adapter, tool } = toolContext([
      {
        body: [
          {
            created_at: "2026-07-28T05:17:14Z",
            creator: null,
            description: null,
            environment: "Production",
            id: 5_634_510_476,
            ref: COMMIT_SHA,
            sha: COMMIT_SHA,
            updated_at: "2026-07-28T05:17:14Z",
          },
        ],
      },
      {
        body: [
          {
            created_at: "2026-07-28T05:17:14Z",
            creator: null,
            id: 16_022_370_846,
            state: "failure",
          },
        ],
      },
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
        creator: null,
        environment: "Production",
        id: 5_634_510_476,
        latestStatus: {
          creator: null,
          description: null,
          environmentUrl: null,
          logUrl: null,
          state: "failure",
        },
      },
      subscribable: {
        identifier: `deployment-source:getsentry/junior-prod:production:${COMMIT_SHA}`,
        suggestedEvents: [
          "deployment.succeeded",
          "deployment.failed",
          "deployment.error",
        ],
        type: "deployment_source",
      },
    });
    const requests = adapter.requests();
    expect(requests).toHaveLength(2);
    const deploymentsRequest = requests[0]?.request;
    expect(deploymentsRequest.url).toContain(`sha=${COMMIT_SHA}`);
    expect(deploymentsRequest.url).toContain("environment=Production");
    expect(requests[0]).toMatchObject({
      operation: "github.deployment.list",
      provider: "github",
    });
    expect(requests[1]).toMatchObject({
      operation: "github.deployment-status.list",
      provider: "github",
    });
  });

  it("returns a subscribable source before GitHub creates the deployment", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { adapter, tool } = toolContext([{ body: [] }]);

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
        identifier: `deployment-source:getsentry/junior-prod:preview:${COMMIT_SHA}`,
      },
    });
    expect(adapter.requests()).toHaveLength(1);
  });

  it("watches every environment for a commit when environment is omitted", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "test-secret");
    const { adapter, tool } = toolContext([{ body: [] }]);

    await expect(
      tool.execute?.(
        {
          commitSha: COMMIT_SHA,
          repo: "GetSentry/Junior-Prod",
        },
        { toolCallId: "watch-commit-deployments" },
      ),
    ).resolves.toMatchObject({
      deployment: null,
      environment: null,
      subscribable: {
        identifier: `deployment-source:getsentry/junior-prod:${COMMIT_SHA}`,
      },
    });
    const [request] = adapter.requests();
    expect(request?.request.url).toContain(`sha=${COMMIT_SHA}`);
    expect(request?.request.url).not.toContain("environment=");
  });

  it("reports a missing repository as a repairable tool error", async () => {
    const { tool } = toolContext([
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        {
          commitSha: COMMIT_SHA,
          environment: "Production",
          repo: "getsentry/missing",
        },
        { toolCallId: "missing-deployment" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub deployment lookup failed with HTTP 404",
      name: "PluginToolInputError",
    });
  });

  it("distinguishes validation failures from provider abuse protection", async () => {
    const validation = toolContext([
      {
        body: {
          errors: [{ field: "environment", code: "invalid" }],
          message: "Validation Failed",
        },
        status: 422,
      },
    ]);
    const abuseProtection = toolContext([
      { body: { message: "Request was spammed" }, status: 422 },
    ]);
    const input = {
      commitSha: COMMIT_SHA,
      environment: "Production",
      repo: "getsentry/junior-prod",
    };

    await expect(
      validation.tool.execute?.(input, { toolCallId: "invalid-deployment" }),
    ).rejects.toMatchObject({ name: "PluginToolInputError" });
    await expect(
      abuseProtection.tool.execute?.(input, {
        toolCallId: "throttled-deployment",
      }),
    ).rejects.toMatchObject({
      message: "GitHub deployment lookup failed with HTTP 422",
      name: "Error",
    });
  });

  it("treats a missing provider-returned status as a runtime error", async () => {
    const { tool } = toolContext([
      {
        body: [
          {
            created_at: "2026-07-28T05:17:14Z",
            creator: null,
            description: null,
            environment: "Production",
            id: 5_634_510_476,
            ref: COMMIT_SHA,
            sha: COMMIT_SHA,
            updated_at: "2026-07-28T05:17:14Z",
          },
        ],
      },
      { body: { message: "Not Found" }, status: 404 },
    ]);

    await expect(
      tool.execute?.(
        {
          commitSha: COMMIT_SHA,
          environment: "Production",
          repo: "getsentry/junior-prod",
        },
        { toolCallId: "missing-deployment-status" },
      ),
    ).rejects.toMatchObject({
      message: "GitHub deployment status lookup failed with HTTP 404",
      name: "Error",
    });
  });
});
