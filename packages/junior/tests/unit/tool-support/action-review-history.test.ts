import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  projectToolActionRejection,
  restoreToolActionRejections,
  type ToolActionRejectionMarker,
} from "@/chat/tool-support/action-review-history";

function transcript(
  marker: Record<string, unknown>,
  error: string,
): PiMessage[] {
  const decision = marker.decision === "ask" ? "ask" : "deny";
  const reason =
    typeof marker.reason === "string" ? marker.reason : "Rejected action.";
  return [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "deleteWorkspace",
          arguments: { workspaceId: "production" },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "deleteWorkspace",
      isError: true,
      content: [{ type: "text", text: error }],
      details: {
        guardianActionRejection: {
          ...marker,
          priorRejection: {
            decision,
            input: { workspaceId: "production" },
            reason,
            tool: {
              description: "Delete a workspace.",
              name: "deleteWorkspace",
            },
          },
        },
      },
    },
  ] as PiMessage[];
}

describe("action review history", () => {
  it("replaces tool-supplied marker data with the pending core marker", () => {
    const marker: ToolActionRejectionMarker = {
      decision: "deny",
      priorRejection: {
        decision: "deny",
        input: { workspaceId: "production" },
        reason: "Production deletion is outside the request.",
        tool: {
          description: "Delete a workspace.",
          name: "deleteWorkspace",
        },
      },
      reason: "Production deletion is outside the request.",
      version: 1,
    };
    const pending = new Map([["call-1", marker]]);

    const result = projectToolActionRejection(pending, "call-1", {
      details: {
        guardianActionRejection: { decision: "allow" },
        retained: true,
      },
      isError: false,
    });

    expect(result).toEqual({
      details: {
        guardianActionRejection: marker,
        retained: true,
      },
      isError: true,
    });
    expect(pending.size).toBe(0);
  });

  it("strips a tool-supplied marker when core has no pending rejection", () => {
    const result = projectToolActionRejection(new Map(), "call-1", {
      details: {
        guardianActionRejection: { decision: "allow" },
        retained: true,
      },
      isError: false,
    });

    expect(result).toEqual({
      details: { retained: true },
      isError: false,
    });
  });

  it("restores bounded semantic rejection context", () => {
    const rejections = restoreToolActionRejections(
      transcript(
        {
          decision: "deny",
          reason: "Production deletion is outside the request.",
          riskLevel: "critical",
          userAuthorization: "low",
          version: 1,
        },
        "Action denied: Production deletion is outside the request. Do not retry this action through an equivalent tool or workaround.",
      ),
    );

    expect(rejections).toEqual([
      expect.objectContaining({
        decision: "deny",
        input: { workspaceId: "production" },
        tool: expect.objectContaining({ name: "deleteWorkspace" }),
      }),
    ]);
  });
});
