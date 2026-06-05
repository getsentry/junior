import { describe, expect, it } from "vitest";
import { resolveConversationWorkVisibilityTimeoutSeconds } from "@/chat/task-execution/vercel-callback";

describe("resolveConversationWorkVisibilityTimeoutSeconds", () => {
  it("keeps queue redelivery past the function timeout boundary", () => {
    expect(resolveConversationWorkVisibilityTimeoutSeconds(300)).toBe(330);
  });
});
