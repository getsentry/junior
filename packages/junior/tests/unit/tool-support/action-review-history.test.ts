import { describe, expect, it } from "vitest";
import type { PiMessage } from "@/chat/pi/messages";
import {
  projectToolActionRejection,
  restoreToolActionReviewState,
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

const ACTOR = { platform: "local", userId: "local-user" } as const;
const PROVENANCE = [
  { authority: "context" as const },
  { authority: "context" as const },
];

describe("action review history", () => {
  it("replaces tool-supplied marker data with the pending core marker", () => {
    const marker: ToolActionRejectionMarker = {
      actionKey: "a".repeat(64),
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
        guardianActionRejection: { actionKey: "spoofed" },
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
        guardianActionRejection: { actionKey: "spoofed" },
        retained: true,
      },
      isError: false,
    });

    expect(result).toEqual({
      details: { retained: true },
      isError: false,
    });
  });

  it("restores exact denials and bounded semantic context", () => {
    const state = restoreToolActionReviewState(
      transcript(
        {
          actionKey: "a".repeat(64),
          decision: "deny",
          reason: "Production deletion is outside the request.",
          riskLevel: "critical",
          userAuthorization: "low",
          version: 1,
        },
        "Action denied: Production deletion is outside the request. Do not retry this action through an equivalent tool or workaround.",
      ),
      PROVENANCE,
      ACTOR,
      "List unused workspaces.",
    );

    expect(state.rejectedActions).toHaveLength(1);
    expect(state.rejectedActions[0]).toMatchObject({
      decision: "deny",
      reason: "Production deletion is outside the request.",
    });
    expect(state.priorRejections).toEqual([
      expect.objectContaining({
        decision: "deny",
        input: { workspaceId: "production" },
        tool: expect.objectContaining({ name: "deleteWorkspace" }),
      }),
    ]);
  });

  it("binds restored asks to the current authoritative intent", () => {
    const state = restoreToolActionReviewState(
      transcript(
        {
          actionKey: "b".repeat(64),
          decision: "ask",
          reason: "Confirm the recurring schedule.",
          riskLevel: "medium",
          userAuthorization: "medium",
          version: 1,
        },
        "Action requires user confirmation: Confirm the recurring schedule.",
      ),
      PROVENANCE,
      ACTOR,
      "Schedule this every weekday.",
    );

    expect(state.priorRejections).toEqual([
      expect.objectContaining({ decision: "ask" }),
    ]);
    expect(state.rejectedActions[0]).toMatchObject({
      decision: "ask",
      key: expect.stringMatching(/^ask:[a-f0-9]{64}:[a-f0-9]{64}$/),
    });
  });

  it("only a later same-actor instruction clears an exact rejection", () => {
    const messages = transcript(
      {
        actionKey: "c".repeat(64),
        decision: "ask",
        reason: "Confirm the schedule.",
        version: 1,
      },
      "Action requires user confirmation: Confirm the schedule.",
    );
    messages.push({
      role: "user",
      content: [{ type: "text", text: "Yes." }],
    } as PiMessage);

    const otherActor = restoreToolActionReviewState(
      messages,
      [
        ...PROVENANCE,
        {
          authority: "instruction",
          actor: { platform: "local", userId: "other-user" },
        },
      ],
      ACTOR,
      "Schedule this every weekday.",
    );
    const sameActor = restoreToolActionReviewState(
      messages,
      [
        ...PROVENANCE,
        {
          authority: "instruction",
          actor: ACTOR,
        },
      ],
      ACTOR,
      "Schedule this every weekday.\n\nYes.",
    );

    expect(otherActor.rejectedActions).toHaveLength(1);
    expect(sameActor.rejectedActions).toEqual([]);
  });

  it("keeps an exact rejection across an empty same-actor follow-up", () => {
    const messages = transcript(
      {
        actionKey: "d".repeat(64),
        decision: "ask",
        reason: "Confirm the schedule.",
        version: 1,
      },
      "Action requires user confirmation: Confirm the schedule.",
    );
    messages.push({
      role: "user",
      content: [{ type: "image", data: "attachment" }],
    } as PiMessage);

    const state = restoreToolActionReviewState(
      messages,
      [
        ...PROVENANCE,
        {
          authority: "instruction",
          actor: ACTOR,
        },
      ],
      ACTOR,
      "Schedule this every weekday.",
    );

    expect(state.rejectedActions).toHaveLength(1);
  });
});
