import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src";
import { createVercelDeploymentSourceTool } from "../src/tools/deployment-source";

const COMMIT_SHA = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

function toolFixture(response: Response = Response.json({ id: "prj_junior" })) {
  const fetch = vi.fn().mockResolvedValue(response);
  return {
    fetch,
    tool: createVercelDeploymentSourceTool({
      egress: { fetch },
    } as never),
  };
}

describe("Vercel deployment source", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves a channel project and returns a subscribable source", async () => {
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
        { toolCallId: "deployment-source" },
      ),
    ).resolves.toMatchObject({
      commitSha: COMMIT_SHA.toLowerCase(),
      deploymentTarget: "production",
      projectId: "prj_junior",
      subscribable: {
        namespace: "vercel",
        identifier: `deployment-source:prj_junior:production:${COMMIT_SHA.toLowerCase()}`,
        suggestedEvents: [
          "deployment.succeeded",
          "deployment.error",
          "deployment.canceled",
        ],
        type: "deployment_source",
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

  it("uses teamId when the remembered team is a Vercel team ID", async () => {
    const { fetch, tool } = toolFixture();

    await tool.execute?.(
      {
        commitSha: COMMIT_SHA,
        project: "junior",
        target: "production",
        team: "team_sentry",
      },
      { toolCallId: "deployment-source-team-id" },
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
      { commitSha: COMMIT_SHA, project: "junior", target: "staging" },
      { toolCallId: "deployment-source-without-webhooks" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("reports project lookup failures", async () => {
    const { tool } = toolFixture(new Response("missing", { status: 404 }));

    await expect(
      tool.execute?.(
        { commitSha: COMMIT_SHA, project: "missing", target: "production" },
        { toolCallId: "deployment-source-missing-project" },
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
    expect(
      plugin.hooks?.tools?.({
        egress: { fetch: vi.fn() },
      } as never),
    ).toHaveProperty("deploymentSource");
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
