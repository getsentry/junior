import { describe, expect, it, vi } from "vitest";
import { createGocdPipelineHistoryTool } from "../src/tools/pipeline-history";

function toolFixture(
  response: Response = Response.json({
    pipelines: [{ name: "demo", counter: 1 }],
  }),
) {
  const fetch = vi.fn().mockResolvedValue(response);
  return {
    fetch,
    tool: createGocdPipelineHistoryTool(
      {
        egress: { fetch },
      } as never,
      { baseUrl: "https://gocd.example.com" },
    ),
  };
}

describe("GoCD pipeline history", () => {
  it("fetches history through egress without reading secrets", async () => {
    const { fetch, tool } = toolFixture();

    await expect(
      tool.execute?.(
        { pipeline: "demo", count: 5 },
        { toolCallId: "history" },
      ),
    ).resolves.toMatchObject({
      baseUrl: "https://gocd.example.com",
      pipeline: "demo",
      runs: [{ name: "demo", counter: 1 }],
      target: "pipeline_history",
    });

    expect(fetch).toHaveBeenCalledWith({
      operation: "gocd.pipeline.history",
      provider: "gocd",
      request: expect.objectContaining({
        method: "GET",
        url: "https://gocd.example.com/go/api/pipelines/demo/history?page_size=10",
      }),
    });
    const request = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(request.headers.get("Accept")).toBe(
      "application/vnd.go.cd.v1+json",
    );
    expect(request.headers.get("Authorization")).toBeNull();
  });

  it("clamps page_size to the GoCD 10..100 range", async () => {
    const { fetch, tool } = toolFixture();
    await tool.execute?.(
      { pipeline: "demo", count: 1 },
      { toolCallId: "history-small" },
    );
    expect(fetch.mock.calls[0]?.[0]?.request.url).toContain("page_size=10");
  });

  it("reports upstream failures", async () => {
    const { tool } = toolFixture(new Response("nope", { status: 403 }));
    await expect(
      tool.execute?.(
        { pipeline: "missing" },
        { toolCallId: "history-missing" },
      ),
    ).rejects.toThrow("GoCD pipeline history failed with HTTP 403");
  });
});
