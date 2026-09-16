import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import type { PiMessage } from "@/chat/pi/messages";
import { COMPACTION_SUMMARY_PREFIX } from "@/chat/services/context-compaction-marker";
import {
  appendOpenPlan,
  latestOpenPlanItems,
} from "@/chat/services/plan-continuation";

function planUpdate(
  id: string,
  plan: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>,
  isError = false,
): PiMessage[] {
  return [
    fauxAssistantMessage([fauxToolCall("updatePlan", { plan }, { id })], {
      stopReason: "toolUse",
    }) as PiMessage,
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "updatePlan",
      content: [{ type: "text", text: "Plan updated" }],
      isError,
      timestamp: 2,
    } as PiMessage,
  ];
}

describe("plan continuation", () => {
  it("keeps exact open items from the latest successful update", () => {
    const messages = [
      ...planUpdate("plan-1", [
        { step: "Old pending step", status: "pending" },
      ]),
      ...planUpdate("plan-2", [
        { step: "Keep  spacing exactly", status: "in_progress" },
        { step: "Run focused tests", status: "pending" },
        { step: "Inspect prior changes", status: "completed" },
      ]),
    ];

    expect(latestOpenPlanItems(messages)).toEqual([
      { step: "Keep  spacing exactly", status: "in_progress" },
      { step: "Run focused tests", status: "pending" },
    ]);
    expect(appendOpenPlan("Continue implementation.", messages)).toBe(
      [
        "Continue implementation.",
        "",
        "<open-plan>",
        '[{"step":"Keep  spacing exactly","status":"in_progress"},{"step":"Run focused tests","status":"pending"}]',
        "</open-plan>",
      ].join("\n"),
    );
  });

  it("carries retained items through later compaction", () => {
    const first = appendOpenPlan(
      "First summary.",
      planUpdate("plan-1", [
        {
          step: "Keep &quot; and &amp; exact",
          status: "in_progress",
        },
      ]),
    );
    const compactedMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text: renderCurrentInstruction(
            `${COMPACTION_SUMMARY_PREFIX}\n${first}`,
          ),
        },
      ],
      timestamp: 3,
    } as PiMessage;

    const echoedSummary = `The prior summary included:\n${first}`;
    expect(appendOpenPlan(echoedSummary, [compactedMessage])).toBe(
      `${echoedSummary}\n\n<open-plan>\n[{"step":"Keep &quot; and &amp; exact","status":"in_progress"}]\n</open-plan>`,
    );
  });

  it("ignores failed updates and omits completed plans", () => {
    const messages = [
      ...planUpdate("plan-1", [{ step: "Keep this task", status: "pending" }]),
      ...planUpdate(
        "plan-2",
        [{ step: "Do not keep this task", status: "pending" }],
        true,
      ),
    ];

    expect(latestOpenPlanItems(messages)).toEqual([
      { step: "Keep this task", status: "pending" },
    ]);
    expect(
      appendOpenPlan(
        "Done.",
        planUpdate("plan-3", [{ step: "Finished task", status: "completed" }]),
      ),
    ).toBe("Done.");
  });
});
