import { describe, expect, it } from "vitest";
import { createEventInboundMessage } from "@/chat/events/notification";
import { readTurnWatch } from "@/chat/events/turn-watch";
import type { WatchCreator } from "@/chat/events/watch-creator";

const person = { platform: "slack", teamId: "T1", userId: "U1" } as const;
const task = { instructions: "Maintain acme/app#1. Fix review feedback." };

function delivered(id: string, creator?: WatchCreator) {
  return createEventInboundMessage({
    event: {
      eventKey: `review-${id}`,
      eventType: "pull_request.review_comment.created",
      identifier: "acme/app#1",
      namespace: "github",
      occurredAtMs: 1,
      trustedSummary: "A review comment was posted.",
    },
    subscription: { conversationId: "conv-1", creator, id },
    task,
    text: "<task>A review comment was posted.</task>",
  });
}

describe("readTurnWatch", () => {
  it("reads the creator that delivery copied from the Watch", () => {
    const creator = { actor: person, plugin: "github" };
    expect(readTurnWatch([delivered("w1", creator)])).toEqual({
      creator,
      events: [task],
    });
  });

  it("keeps a Watch with no creator, or mixed creators, as context", () => {
    expect(readTurnWatch([delivered("w1")])).toBeUndefined();
    expect(
      readTurnWatch([delivered("w1", { actor: person }), delivered("w2", {})]),
    ).toBeUndefined();
  });
});
