import { describe, expect, it, vi } from "vitest";
import { createGocdJobLogTool } from "../src/tools/job-log";

function toolFixture(response: Response) {
  const fetch = vi.fn().mockResolvedValue(response);
  return {
    fetch,
    tool: createGocdJobLogTool({ egress: { fetch } } as never, {
      baseUrl: "https://gocd.example.com",
    }),
  };
}

const input = {
  pipeline: "deploy-getsentry-backend-de",
  pipelineCounter: 7,
  stage: "deploy-primary",
  stageCounter: 1,
  job: "create-sentry-release",
  tail: 200,
};

describe("GoCD job log", () => {
  it("returns deduped, redacted console output with a stable link", async () => {
    const text = [
      "start",
      "Authorization: bearer SECRETTOKENVALUE",
      "waiting for pod 1",
      "waiting for pod 2",
      "waiting for pod 3",
      "waiting for pod 4",
      "end",
    ].join("\n");
    const { fetch, tool } = toolFixture(new Response(text, { status: 200 }));

    const result = (await tool.execute?.(input, {
      toolCallId: "job-log",
    })) as any;

    expect(result.target).toBe("jobLog");
    expect(result.available).toBe(true);
    expect(result.deduped).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.totalLines).toBe(5);
    expect(result.returnedLines).toBe(5);
    expect(result.log).not.toContain("SECRETTOKENVALUE");
    expect(result.link).toBe(
      "https://gocd.example.com/go/tab/build/detail/deploy-getsentry-backend-de/7/deploy-primary/1/create-sentry-release",
    );

    expect(fetch).toHaveBeenCalledWith({
      operation: "gocd.job.log",
      provider: "gocd",
      request: expect.objectContaining({
        method: "GET",
        url: "https://gocd.example.com/go/files/deploy-getsentry-backend-de/7/deploy-primary/1/create-sentry-release/cruise-output/console.log",
      }),
    });
    const request = fetch.mock.calls[0]?.[0]?.request as Request;
    expect(request.headers.get("Authorization")).toBeNull();
  });

  it("tails to the requested number of lines", async () => {
    const text = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].join(
      "\n",
    );
    const { tool } = toolFixture(new Response(text, { status: 200 }));

    const result = (await tool.execute?.(
      { ...input, tail: 2 },
      { toolCallId: "job-log-tail" },
    )) as any;

    expect(result.returnedLines).toBe(2);
    expect(result.totalLines).toBe(6);
    expect(result.truncated).toBe(true);
    expect(result.log).toBe("echo\nfoxtrot");
  });

  it("reports expired or unavailable logs without throwing", async () => {
    const { tool } = toolFixture(new Response("", { status: 404 }));
    const result = (await tool.execute?.(input, {
      toolCallId: "job-log-expired",
    })) as any;
    expect(result.available).toBe(false);
    expect(result.log).toBe("");
  });

  it("throws on non-404 upstream failures", async () => {
    const { tool } = toolFixture(new Response("boom", { status: 500 }));
    await expect(
      tool.execute?.(input, { toolCallId: "job-log-error" }),
    ).rejects.toThrow("GoCD job log failed with HTTP 500");
  });
});
