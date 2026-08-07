import { describe, expect, it } from "vitest";
import {
  evidence,
  localContext,
  priorRejection,
  proposal,
  slackContext,
} from "../../evals/guardian/helpers";

describe("guardian eval helpers", () => {
  it("builds a local proposal snapshot with only supplied optional fields", () => {
    const snapshot = proposal({
      context: localContext("Delete preview-18."),
      input: { workspace: "preview-18" },
      tool: {
        description: "Delete a workspace.",
        name: "delete-eval-workspace",
      },
    });

    expect(snapshot).toEqual({
      context: {
        actor: { platform: "local", userId: "local-user" },
        conversationId: "local:guardian-eval",
        destination: {
          platform: "local",
          conversationId: "local:guardian-eval",
        },
        source: {
          platform: "local",
          visibility: "private",
          conversationId: "local:guardian-eval",
        },
        userIntent: "Delete preview-18.",
      },
      input: { workspace: "preview-18" },
      tool: {
        description: "Delete a workspace.",
        name: "delete-eval-workspace",
      },
    });
    expect(snapshot).not.toHaveProperty("evidence");
    expect(snapshot).not.toHaveProperty("priorRejectedActions");
  });

  it("includes evidence and prior rejections when provided", () => {
    const tool = {
      description: "Delete a workspace.",
      name: "delete-eval-workspace",
    };
    const snapshot = proposal({
      context: slackContext("Clean up preview-42 if needed."),
      evidence: evidence([{ role: "user", text: "Clean up preview-42 if needed." }]),
      input: { workspace: "preview-42" },
      priorRejectedActions: [
        priorRejection({
          decision: "ask",
          input: { workspace: "preview-42" },
          reason: "Needs confirmation.",
          tool,
        }),
      ],
      tool,
    });

    expect(snapshot.context.actor).toEqual({
      platform: "slack",
      teamId: "TGUARDIAN",
      userId: "UACTOR",
    });
    expect(snapshot.evidence).toEqual({
      entries: [{ role: "user", text: "Clean up preview-42 if needed." }],
      omittedEntries: 0,
    });
    expect(snapshot.priorRejectedActions).toEqual([
      {
        decision: "ask",
        input: { workspace: "preview-42" },
        reason: "Needs confirmation.",
        tool,
      },
    ]);
  });
});
