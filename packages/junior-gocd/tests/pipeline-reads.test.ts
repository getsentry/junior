import { describe, expect, it, vi } from "vitest";
import { createGocdJobHistoryTool } from "../src/tools/job-history";
import { createGocdPipelineRunTool } from "../src/tools/pipeline-run";
import { createGocdPipelineStatusTool } from "../src/tools/pipeline-status";

function context(response: Response) {
  return { egress: { fetch: vi.fn().mockResolvedValue(response) } } as never;
}

const options = { baseUrl: "https://gocd.example.com" };

describe("GoCD pipeline reads", () => {
  it("returns a pipeline run without source or user fields", async () => {
    const tool = createGocdPipelineRunTool(
      context(
        Response.json({
          name: "deploy-api",
          counter: 42,
          label: "42",
          scheduled_date: 123,
          build_cause: {
            trigger_message: "person@example.com",
            material_revisions: [{ modifications: [{ comment: "secret" }] }],
          },
          stages: [
            {
              name: "deploy",
              counter: "1",
              result: "Failed",
              status: "Failed",
              scheduled: true,
              approved_by: "person",
              jobs: [
                {
                  name: "deploy",
                  result: "Failed",
                  state: "Completed",
                  agent_uuid: "secret-agent",
                },
              ],
            },
          ],
        }),
      ),
      options,
    );

    await expect(
      tool.execute?.(
        { pipeline: "deploy-api", pipelineCounter: 42 },
        { toolCallId: "run" },
      ),
    ).resolves.toEqual({
      target: "pipeline_run",
      baseUrl: "https://gocd.example.com",
      pipeline: "deploy-api",
      pipelineCounter: 42,
      label: "42",
      scheduledAt: 123,
      stages: [
        {
          name: "deploy",
          counter: "1",
          result: "Failed",
          status: "Failed",
          scheduled: true,
          jobs: [{ name: "deploy", result: "Failed", state: "Completed" }],
        },
      ],
    });
  });

  it("uses the GoCD pipeline instance endpoint", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        Response.json({ name: "deploy-api", counter: 42, label: "42" }),
      );
    const tool = createGocdPipelineRunTool(
      { egress: { fetch } } as never,
      options,
    );

    await tool.execute?.(
      { pipeline: "deploy-api", pipelineCounter: 42 },
      { toolCallId: "run-path" },
    );

    expect(fetch.mock.calls[0]?.[0]?.request.url).toBe(
      "https://gocd.example.com/go/api/pipelines/deploy-api/42",
    );
  });

  it("classifies a missing pipeline run as model-repairable", async () => {
    const tool = createGocdPipelineRunTool(
      context(new Response("missing", { status: 404 })),
      options,
    );

    await expect(
      tool.execute?.(
        { pipeline: "missing", pipelineCounter: 42 },
        { toolCallId: "missing-run" },
      ),
    ).rejects.toMatchObject({
      name: "PluginToolInputError",
      message: "GoCD pipeline run failed with HTTP 404",
    });
  });

  it("returns pipeline status without pause details", async () => {
    const tool = createGocdPipelineStatusTool(
      context(
        Response.json({
          paused: true,
          paused_cause: "secret",
          paused_by: "person",
          locked: false,
          schedulable: false,
        }),
      ),
      options,
    );

    await expect(
      tool.execute?.({ pipeline: "deploy-api" }, { toolCallId: "status" }),
    ).resolves.toEqual({
      target: "pipeline_status",
      baseUrl: "https://gocd.example.com",
      pipeline: "deploy-api",
      paused: true,
      locked: false,
      schedulable: false,
    });
  });

  it("uses GoCD job history page_size pagination", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ jobs: [] }));
    const tool = createGocdJobHistoryTool(
      { egress: { fetch } } as never,
      options,
    );

    await tool.execute?.(
      { pipeline: "deploy-api", stage: "deploy", job: "deploy", count: 20 },
      { toolCallId: "job-path" },
    );

    expect(fetch.mock.calls[0]?.[0]?.request.url).toBe(
      "https://gocd.example.com/go/api/jobs/deploy-api/deploy/deploy/history?page_size=20",
    );
  });

  it("returns job history without agent identifiers", async () => {
    const tool = createGocdJobHistoryTool(
      context(
        Response.json({
          jobs: [
            {
              name: "deploy",
              agent_uuid: "secret-agent",
              scheduled_date: 123,
              pipeline_counter: 42,
              rerun: false,
              result: "Failed",
              state: "Completed",
              stage_counter: "1",
            },
          ],
        }),
      ),
      options,
    );

    await expect(
      tool.execute?.(
        { pipeline: "deploy-api", stage: "deploy", job: "deploy", count: 1 },
        { toolCallId: "jobs" },
      ),
    ).resolves.toEqual({
      target: "job_history",
      baseUrl: "https://gocd.example.com",
      pipeline: "deploy-api",
      stage: "deploy",
      job: "deploy",
      runs: [
        {
          pipelineCounter: 42,
          stageCounter: "1",
          scheduledAt: 123,
          rerun: false,
          result: "Failed",
          state: "Completed",
        },
      ],
    });
  });
});
