import { describe, expect, it } from "vitest";
import { buildReplyDeliveryPlan } from "@/chat/services/reply-delivery-plan";

describe("buildReplyDeliveryPlan", () => {
  it("keeps finalized replies in the thread without files", () => {
    expect(
      buildReplyDeliveryPlan({
        hasFiles: false,
      }),
    ).toEqual({
      mode: "thread",
      postThreadText: true,
      attachFiles: "none",
    });
  });

  it("keeps files inline with finalized thread replies", () => {
    expect(
      buildReplyDeliveryPlan({
        hasFiles: true,
      }),
    ).toEqual({
      mode: "thread",
      postThreadText: true,
      attachFiles: "inline",
    });
  });
});
