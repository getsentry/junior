import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src";
import { createVercelDeploymentTool } from "../src/tools/deployment";

const COMMIT_SHA = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

function toolFixture(
  response: Response = Response.json({ id: "prj_junior" }),
  canSubscribe = true,
) {
  const fetch = vi.fn().mockResolvedValue(response);
  return {
    fetch,
    tool: createVercelDeploymentTool({
      egress: { fetch },
      resourceEvents: { canSubscribe },
    } as never),
  };
}

describe("Vercel deployment", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a channel project and returns a commit-scoped subscribable resource", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", " webhook-secret ");
    const { fetch, tool } = toolFixture();

    await expect(
      tool.execute?.(
        {
          commitSha: COMMIT_SHA,
          project: "junior",
          target: "production",
          team: "sentry",
        },
        { toolCallId: "deployment" },
      ),
    ).resolves.toMatchObject({
      commitSha: COMMIT_SHA.toLowerCase(),
      deploymentTarget: "production",
      projectId: "prj_junior",
      subscribable: {
        namespace: "vercel",
        identifier: `prj_junior:production:${COMMIT_SHA.toLowerCase()}`,
        suggestedEvents: [
          "deployment.succeeded",
          "deployment.error",
          "deployment.canceled",
        ],
        type: "deployment",
      },
    });
    expect(fetch).toHaveBeenCalledWith({
      operation: "vercel.project.get",
      provider: "vercel",
      request: expect.objectContaining({
        url: "https://api.vercel.com/v9/projects/junior?slug=sentry",
      }),
    });
  });

  it("accepts an opaque project ID returned by Vercel", async () => {
    const { tool } = toolFixture(Response.json({ id: "QmLegacyProject123" }));

    await expect(
      tool.execute?.(
        { project: "sentry-docs" },
        { toolCallId: "deployment-legacy-project" },
      ),
    ).resolves.toMatchObject({
      projectId: "QmLegacyProject123",
    });
  });

  it("returns a project-wide subscribable resource when commit and target are omitted", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "webhook-secret");
    const { tool } = toolFixture();

    await expect(
      tool.execute?.(
        { project: "junior" },
        { toolCallId: "deployment-project" },
      ),
    ).resolves.toMatchObject({
      commitSha: null,
      deploymentTarget: null,
      projectId: "prj_junior",
      subscribable: {
        identifier: "prj_junior",
        label: "Vercel deployments for prj_junior",
        type: "deployment",
      },
    });
  });

  it("returns a target-scoped subscribable resource without a commit", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "webhook-secret");
    const { tool } = toolFixture();

    await expect(
      tool.execute?.(
        { project: "junior", target: "production" },
        { toolCallId: "deployment-target" },
      ),
    ).resolves.toMatchObject({
      commitSha: null,
      deploymentTarget: "production",
      projectId: "prj_junior",
      subscribable: {
        identifier: "prj_junior:production",
        label: "Vercel production deployments for prj_junior",
        type: "deployment",
      },
    });
  });

  it("defaults a commit-scoped watch to production when target is omitted", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "webhook-secret");
    const { tool } = toolFixture();

    await expect(
      tool.execute?.(
        { commitSha: COMMIT_SHA, project: "junior" },
        { toolCallId: "deployment-default-target" },
      ),
    ).resolves.toMatchObject({
      commitSha: COMMIT_SHA.toLowerCase(),
      deploymentTarget: "production",
      projectId: "prj_junior",
      subscribable: {
        identifier: `prj_junior:production:${COMMIT_SHA.toLowerCase()}`,
      },
    });
  });

  it("uses teamId when the remembered team is a Vercel team ID", async () => {
    const { fetch, tool } = toolFixture();

    await tool.execute?.(
      {
        commitSha: COMMIT_SHA,
        project: "junior",
        target: "production",
        team: "team_sentry",
      },
      { toolCallId: "deployment-team-id" },
    );

    expect(fetch).toHaveBeenCalledWith({
      operation: "vercel.project.get",
      provider: "vercel",
      request: expect.objectContaining({
        url: "https://api.vercel.com/v9/projects/junior?teamId=team_sentry",
      }),
    });
  });

  it("omits the subscribable hint when webhook verification is unavailable", async () => {
    const { tool } = toolFixture();

    const result = await tool.execute?.(
      { project: "junior", target: "staging" },
      { toolCallId: "deployment-without-webhooks" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("omits the subscribable hint when the host cannot create subscriptions", async () => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "webhook-secret");
    const { tool } = toolFixture(undefined, false);

    const result = await tool.execute?.(
      { project: "junior", target: "staging" },
      { toolCallId: "deployment-without-subscriptions" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("reports project lookup failures", async () => {
    const { tool } = toolFixture(new Response("missing", { status: 404 }));

    await expect(
      tool.execute?.(
        { project: "missing", target: "production" },
        { toolCallId: "deployment-missing-project" },
      ),
    ).rejects.toThrow("Vercel project lookup failed with HTTP 404");
  });

  it("registers runtime hooks and the canonical inline manifest", () => {
    const plugin = vercelPlugin();

    expect(plugin.packageName).toBe("@sentry/junior-vercel");
    expect(plugin.manifest).toMatchObject({
      name: "vercel",
      apiHeaders: {
        Authorization: "Bearer ${JUNIOR_VERCEL_TOKEN}",
      },
      envVars: {
        JUNIOR_VERCEL_TOKEN: {},
        VERCEL_WEBHOOK_SECRET: {},
      },
    });
    expect(plugin.resourceEvents?.resourceTypes).toEqual([
      expect.objectContaining({ type: "deployment" }),
    ]);
    expect(
      plugin.hooks?.tools?.({
        egress: { fetch: vi.fn() },
      } as never),
    ).toHaveProperty("deployment");
    expect(
      plugin.hooks?.routes?.({
        resourceEvents: { async publish() {} },
      } as never),
    ).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/webhooks/vercel",
      }),
    ]);
  });
});
