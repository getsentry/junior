import { describe, expect, it } from "vitest";
import {
  instructionActors,
  type ConversationMessageProvenance,
} from "@/chat/conversations/provenance";

describe("instructionActors", () => {
  it("deduplicates actor identities while preserving the first representation", () => {
    const provenance: ConversationMessageProvenance[] = [
      {
        authority: "instruction",
        actor: {
          platform: "slack",
          teamId: "T1",
          userId: "U1",
          userName: "first",
        },
      },
      {
        authority: "instruction",
        actor: {
          platform: "slack",
          teamId: "T1",
          userId: "U1",
          userName: "renamed",
        },
      },
    ];

    expect(instructionActors(provenance)).toEqual([provenance[0]!.actor]);
  });

  it("keeps identities distinct across platforms and Slack workspaces", () => {
    const provenance: ConversationMessageProvenance[] = [
      {
        authority: "instruction",
        actor: { platform: "slack", teamId: "T1", userId: "U1" },
      },
      {
        authority: "instruction",
        actor: { platform: "slack", teamId: "T2", userId: "U1" },
      },
      {
        authority: "instruction",
        actor: { platform: "local", userId: "U1" },
      },
      {
        authority: "instruction",
        actor: { platform: "system", name: "scheduler" },
      },
      {
        authority: "instruction",
        actor: { platform: "system", name: "scheduler" },
      },
      {
        authority: "context",
        actor: { platform: "local", userId: "ignored" },
      },
    ];

    expect(instructionActors(provenance)).toEqual([
      provenance[0]!.actor,
      provenance[1]!.actor,
      provenance[2]!.actor,
      provenance[3]!.actor,
    ]);
  });
});
