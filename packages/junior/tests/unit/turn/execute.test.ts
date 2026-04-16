import { describe, expect, it } from "vitest";
import { resolveReplyDelivery } from "@/chat/services/reply-delivery-plan";

describe("resolveReplyDelivery", () => {
  it("uses delivery plan directly when available", () => {
    const resolved = resolveReplyDelivery({
      reply: {
        text: "Done.",
        files: [],
        deliveryPlan: {
          mode: "channel_only",

          postThreadText: false,
          attachFiles: "none",
        },
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: false,
      attachFiles: "none",
    });
  });

  it("falls back to inline files for legacy thread replies", () => {
    const resolved = resolveReplyDelivery({
      reply: {
        text: "Done.",
        files: [{ data: Buffer.from("x"), filename: "a.txt" }],
        deliveryMode: "thread",

        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: true,
      attachFiles: "inline",
    });
  });

  it("coerces legacy followup file plans to inline delivery", () => {
    const resolved = resolveReplyDelivery({
      reply: {
        text: "Done.",
        files: [{ data: Buffer.from("x"), filename: "a.txt" }],
        deliveryPlan: {
          mode: "thread",
          postThreadText: true,
          attachFiles: "followup",
        },
        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: true,
      attachFiles: "inline",
    });
  });

  it("always posts thread reply for reaction-only turns to complete Slack response cycle", () => {
    const resolved = resolveReplyDelivery({
      reply: {
        text: "👍",
        files: [],

        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: true,
      attachFiles: "none",
    });
  });

  it("keeps thread text when a reaction accompanies a substantive reply", () => {
    const resolved = resolveReplyDelivery({
      reply: {
        text: "Added the reaction. I also posted the update in channel.",
        files: [],

        diagnostics: {
          assistantMessageCount: 1,
          modelId: "model",
          outcome: "success",
          toolCalls: [],
          toolErrorCount: 0,
          toolResultCount: 0,
          usedPrimaryText: true,
        },
      },
    });

    expect(resolved).toEqual({
      shouldPostThreadReply: true,
      attachFiles: "none",
    });
  });
});
