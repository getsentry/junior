import { describe, expect, it } from "vitest";
import { resolveReplyDelivery } from "@/chat/turn/execute";

describe("resolveReplyDelivery", () => {
  it("uses delivery plan directly when available", () => {
    const resolved = resolveReplyDelivery({
      hasStreamedThreadReply: true,
      reply: {
        text: "Done.",
        files: [],
        deliveryPlan: {
          mode: "channel_only",
          ack: "none",
          postThreadText: false,
          attachFiles: "none"
        },
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true
        }
      }
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: false,
      attachFiles: "none"
    });
  });

  it("falls back to inline files when legacy followup path has no stream", () => {
    const resolved = resolveReplyDelivery({
      hasStreamedThreadReply: false,
      reply: {
        text: "Done.",
        files: [{ data: Buffer.from("x"), filename: "a.txt" }],
        deliveryMode: "thread",
        ackStrategy: "none",
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true
        }
      }
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: true,
      attachFiles: "inline"
    });
  });
});
