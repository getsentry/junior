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
          kind: "local",
          visibility: "private",
          conversationId: "local:guardian-eval",
        },
        userIntent: "Delete preview-18.",
      },
      input: { workspace: "preview-18" },
      // Core persists the current message first, so it is the root's last line.
      rootConversation: {
        messages: [{ author: "user", text: "Delete preview-18." }],
        truncated: false,
      },
      tool: {
        description: "Delete a workspace.",
        name: "delete-eval-workspace",
      },
    });
    expect(snapshot).not.toHaveProperty("evidence");
    expect(snapshot).not.toHaveProperty("priorRejectedActions");
  });

  it("moves a person's messages into the root and keeps tool evidence", () => {
    const tool = {
      description: "Delete a workspace.",
      name: "delete-eval-workspace",
    };
    const snapshot = proposal({
      context: slackContext("Clean up preview-42 if needed."),
      evidence: evidence([
        { role: "user", text: "Check preview-42." },
        { role: "assistant", text: "preview-42 is idle." },
        { role: "tool listWorkspaces result", text: "preview-42: idle" },
      ]),
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
    expect(snapshot.rootConversation).toEqual({
      messages: [
        { author: "user", text: "Check preview-42." },
        { author: "assistant", text: "preview-42 is idle." },
        { author: "user", text: "Clean up preview-42 if needed." },
      ],
      truncated: false,
    });
    expect(snapshot.evidence).toEqual({
      entries: [
        { role: "tool listWorkspaces result", text: "preview-42: idle" },
      ],
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
