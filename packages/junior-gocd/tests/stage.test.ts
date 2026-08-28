import { describe, expect, it, vi } from "vitest";
import { createGocdStageTool } from "../src/tools/stage";

function toolFixture(
  response: Response = Response.json({
    result: "Failed",
    _embedded: {
      jobs: [
        {
          name: "create-sentry-release",
          result: "Failed",
          state: "Completed",
        },
        { name: "warm-cache", result: "Passed", state: "Completed" },
      ],
    },
  }),
) {
  const fetch = vi.fn().mockResolvedValue(response);
  return {
    fetch,
    tool: createGocdStageTool({ egress: { fetch } } as never, {
      baseUrl: "https://gocd.example.com",
    }),
  };
}

const input = {
  pipeline: "deploy-getsentry-backend-de",
  pipelineCounter: 7,
  stage: "deploy-primary",
  stageCounter: 1,
};

describe("GoCD stage", () => {
  it("returns the HAL stage jobs, failed job names, and a stable link", async () => {
    const { fetch, tool } = toolFixture();

    await expect(
      tool.execute?.(input, { toolCallId: "stage" }),
    ).resolves.toMatchObject({
      target: "stage",
      baseUrl: "https://gocd.example.com",
      pipeline: "deploy-getsentry-backend-de",
      stage: "deploy-primary",
      result: "Failed",
      failedJobs: ["create-sentry-release"],
      jobs: [
        {
          name: "create-sentry-release",
          result: "Failed",
          state: "Completed",
        },
        { name: "warm-cache", result: "Passed", state: "Completed" },
      ],
      link: "https://gocd.example.com/go/pipelines/deploy-getsentry-backend-de/7/deploy-primary/1",
    });

    expect(fetch).toHaveBeenCalledWith({
      operation: "gocd.stage",
      provider: "gocd",
      request: expect.objectContaining({
        method: "GET",
        url: "https://gocd.example.com/go/api/stages/deploy-getsentry-backend-de/deploy-primary/instance/7/1",
      }),
    });
    const request = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(request.headers.get("Accept")).toBe("application/vnd.go.cd.v3+json");
    expect(request.headers.get("Authorization")).toBeNull();
  });

  it("reports upstream failures", async () => {
    const { tool } = toolFixture(new Response("nope", { status: 404 }));
    await expect(
      tool.execute?.(input, { toolCallId: "stage-missing" }),
    ).rejects.toThrow("GoCD stage failed with HTTP 404");
  });
});
