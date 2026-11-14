import { describe, expect, it } from "vitest";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { PiMessage } from "@/chat/pi/messages";
import {
  buildPlanStatus,
  latestProgressStatus,
} from "@/chat/runtime/report-progress";

const output = {
  items: [
    { id: 4, title: "Brief the child", status: "pending", assignee: "Echo" },
    {
      id: 5,
      title: "Implement the MVP",
      status: "in_progress",
      assignee: "self",
    },
  ],
};

function planResult(details: unknown, id = "plan-1"): PiMessage[] {
  return [
    fauxAssistantMessage([fauxToolCall("updatePlan", {}, { id })], {
      stopReason: "toolUse",
    }),
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "updatePlan",
      content: [{ type: "text", text: JSON.stringify(details) }],
      isError: false,
      timestamp: 1,
    } as PiMessage,
  ];
}

describe("plan status", () => {
  it("shows the item that the plan's own agent has in progress", () => {
    expect(buildPlanStatus(output)).toEqual({ text: "Implement the MVP" });
    // A child agent's item in progress is not this agent's status.
    expect(
      buildPlanStatus({
        items: [{ ...output.items[0], status: "in_progress" }],
      }),
    ).toBeUndefined();
  });

  it("recovers the status from the latest result that changed an own item", () => {
    expect(
      latestProgressStatus([
        fauxAssistantMessage(
          [fauxToolCall("reportProgress", { message: "Old status" })],
          { stopReason: "toolUse" },
        ),
        ...planResult(output),
        // Changing only a child's item keeps the status.
        ...planResult({ items: [output.items[0]] }, "plan-2"),
      ]),
    ).toEqual({ text: "Implement the MVP" });
    // Closing the own item clears the status, without reviving older ones.
    expect(
      latestProgressStatus([
        fauxAssistantMessage(
          [fauxToolCall("reportProgress", { message: "Old status" })],
          { stopReason: "toolUse" },
        ),
        ...planResult({ items: [{ ...output.items[1], status: "done" }] }),
      ]),
    ).toBeUndefined();
  });
});
