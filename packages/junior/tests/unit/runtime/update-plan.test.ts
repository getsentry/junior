import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  buildPlanStatus,
  latestProgressStatus,
} from "@/chat/runtime/report-progress";
import { createUpdatePlanTool } from "@/chat/tools/runtime/update-plan";

const plan = [
  { step: "Inspect current behavior", status: "completed" as const },
  { step: "Implement the MVP", status: "in_progress" as const },
  { step: "Run checks", status: "pending" as const },
];

describe("task plan", () => {
  it("projects the active step as assistant status", () => {
    expect(buildPlanStatus({ plan })).toEqual({ text: "Implement the MVP" });
    expect(
      buildPlanStatus({
        plan: plan.map((item) => ({ ...item, status: "completed" })),
      }),
    ).toBeUndefined();
  });

  it("recovers the latest plan from Pi history", () => {
    expect(
      latestProgressStatus([
        fauxAssistantMessage(
          [fauxToolCall("updatePlan", { plan }, { id: "plan-1" })],
          {
            stopReason: "toolUse",
          },
        ),
      ]),
    ).toEqual({ text: "Implement the MVP" });
  });

  it("does not revive older progress after the plan completes", () => {
    expect(
      latestProgressStatus([
        fauxAssistantMessage(
          [fauxToolCall("reportProgress", { message: "Old status" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [
            fauxToolCall("updatePlan", {
              plan: plan.map((item) => ({
                ...item,
                status: "completed",
              })),
            }),
          ],
          { stopReason: "toolUse" },
        ),
      ]),
    ).toBeUndefined();
  });

  it("matches the Codex schema and result", async () => {
    const tool = createUpdatePlanTool();
    const input = tool.prepareArguments({
      explanation: "Scope changed",
      plan: [
        { step: "First", status: "in_progress" },
        { step: "Second", status: "in_progress" },
      ],
    });

    expect(input).toEqual({
      explanation: "Scope changed",
      plan: [
        { step: "First", status: "in_progress" },
        { step: "Second", status: "in_progress" },
      ],
    });
    await expect(tool.execute?.(input, {} as never)).resolves.toEqual({
      content: [{ type: "text", text: "Plan updated" }],
    });
  });
});
