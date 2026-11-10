import { describe, expect, it } from "vitest";
import { progressReplyMeta } from "@/chat/progress-reply";

describe("progressReplyMeta", () => {
  it("marks a progress reply without cards", () => {
    expect(progressReplyMeta({ progress: true }, [])).toEqual({
      progress: true,
    });
  });

  it("keeps a reply with a card notifying", () => {
    expect(progressReplyMeta({ progress: true }, [{}])).toBeUndefined();
  });

  it("leaves an unmarked reply alone", () => {
    expect(progressReplyMeta(undefined, [])).toBeUndefined();
  });
});
