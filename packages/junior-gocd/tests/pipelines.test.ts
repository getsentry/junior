import { describe, expect, it, vi } from "vitest";
import { createGocdPipelinesTool } from "../src/tools/pipelines";

describe("GoCD pipelines", () => {
  it("returns pipeline discovery data without user or permission fields", async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        _embedded: {
          pipeline_groups: [
            { name: "deploy", pipelines: ["deploy-api"], can_administer: true },
          ],
          environments: [
            {
              name: "production",
              pipelines: ["deploy-api"],
              can_administer: true,
            },
          ],
          pipelines: [
            {
              name: "deploy-api",
              last_updated_timestamp: 123,
              locked: false,
              pause_info: {
                paused: true,
                paused_by: "person",
                pause_reason: "secret",
              },
              can_operate: true,
              can_administer: true,
              can_unlock: true,
              can_pause: true,
              from_config_repo: true,
              _embedded: {
                instances: [
                  {
                    label: "42",
                    counter: 42,
                    triggered_by: "person",
                    scheduled_at: "2026-08-29T00:00:00Z",
                    _embedded: {
                      stages: [
                        {
                          name: "deploy",
                          counter: "1",
                          status: "Failed",
                          approved_by: "person",
                          cancelled_by: "person",
                          scheduled_at: "2026-08-29T00:01:00Z",
                        },
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    );
    const tool = createGocdPipelinesTool({ egress: { fetch } } as never, {
      baseUrl: "https://gocd.example.com",
    });

    const result = await tool.execute?.({}, { toolCallId: "pipelines" });

    expect(result).toEqual({
      target: "pipelines",
      baseUrl: "https://gocd.example.com",
      pipelines: [
        {
          name: "deploy-api",
          lastUpdatedAt: 123,
          locked: false,
          paused: true,
          runs: [
            {
              label: "42",
              counter: 42,
              scheduledAt: "2026-08-29T00:00:00Z",
              stages: [
                {
                  name: "deploy",
                  counter: "1",
                  status: "Failed",
                  scheduledAt: "2026-08-29T00:01:00Z",
                },
              ],
            },
          ],
        },
      ],
      environments: [{ name: "production", pipelines: ["deploy-api"] }],
      pipelineGroups: [{ name: "deploy", pipelines: ["deploy-api"] }],
    });
    expect(fetch.mock.calls[0]?.[0]?.request.headers.get("Accept")).toBe(
      "application/vnd.go.cd.v4+json",
    );
  });
});
