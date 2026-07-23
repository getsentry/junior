import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vercelPlugin } from "../src";
import { createVercelDeploymentSourceTool } from "../src/tools/deployment-source";

const COMMIT_SHA = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";

describe("Vercel deployment source", () => {
  beforeEach(() => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns a subscribable source using the host project", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_junior");
    vi.stubEnv("VERCEL_WEBHOOK_SECRET", "webhook-secret");
    const tool = createVercelDeploymentSourceTool();

    await expect(
      tool.execute?.(
        { commitSha: COMMIT_SHA, target: "production" },
        { toolCallId: "deployment-source" },
      ),
    ).resolves.toMatchObject({
      commitSha: COMMIT_SHA.toLowerCase(),
      deploymentTarget: "production",
      projectId: "prj_junior",
      subscribable: {
        provider: "vercel",
        resourceRef: `vercel:deployment-source:prj_junior:production:${COMMIT_SHA.toLowerCase()}`,
        suggestedEvents: [
          "deployment.succeeded",
          "deployment.error",
          "deployment.canceled",
        ],
        type: "deployment_source",
      },
    });
  });

  it("omits the subscribable hint when webhook verification is unavailable", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_junior");
    const tool = createVercelDeploymentSourceTool();

    const result = await tool.execute?.(
      { commitSha: COMMIT_SHA, target: "staging" },
      { toolCallId: "deployment-source-without-webhooks" },
    );

    expect(result).not.toHaveProperty("subscribable");
    expect(result).not.toHaveProperty("data.subscribable");
  });

  it("requires an explicit or host Vercel project ID", async () => {
    const tool = createVercelDeploymentSourceTool();

    await expect(
      tool.execute?.(
        { commitSha: COMMIT_SHA, target: "production" },
        { toolCallId: "deployment-source-without-project" },
      ),
    ).rejects.toThrow("projectId must be a Vercel project ID");
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
        VERCEL_PROJECT_ID: {},
        VERCEL_WEBHOOK_SECRET: {},
      },
    });
    expect(plugin.hooks?.tools?.({} as never)).toHaveProperty(
      "deploymentSource",
    );
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
