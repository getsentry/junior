import { describe, expect, it } from "vitest";
import { resolveConversationWorkQueueTopic } from "@/chat/task-execution/vercel-queue";

describe("resolveConversationWorkQueueTopic", () => {
  it("normalizes explicit queue topics", () => {
    expect(resolveConversationWorkQueueTopic({ topic: " local_work " })).toBe(
      "local_work",
    );
  });
});
