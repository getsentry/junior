import { describe, expect, it, vi } from "vitest";
import { createGocdJobHistoryTool } from "../src/tools/job-history";
import { createGocdPipelineInstanceTool } from "../src/tools/pipeline-instance";
import { createGocdPipelineStatusTool } from "../src/tools/pipeline-status";

function context(response: Response) {
  return { egress: { fetch: vi.fn().mockResolvedValue(response) } } as never;
}

const options = { baseUrl: "https://gocd.example.com" };

describe("GoCD pipeline reads", () => {
  it("returns a pipeline run without source or user fields", async () => {
    const tool = createGocdPipelineInstanceTool(
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
        { toolCallId: "instance" },
      ),
    ).resolves.toEqual({
      target: "pipeline_instance",
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
