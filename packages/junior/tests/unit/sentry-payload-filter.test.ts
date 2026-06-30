import { describe, expect, it } from "vitest";
import { runWithConversationPrivacy } from "@/chat/conversation-privacy";
import {
  scrubPrivateSentryLog,
  scrubPrivateSentrySpan,
  scrubPrivateSentryTransaction,
} from "@/chat/sentry-payload-filter";

type SentrySpan = Parameters<typeof scrubPrivateSentrySpan>[0];
type SentryLog = Parameters<typeof scrubPrivateSentryLog>[0];
type SentryTransaction = Parameters<typeof scrubPrivateSentryTransaction>[0];

function messageAttribute(text: string): string {
  return JSON.stringify([{ role: "user", content: text }]);
}

describe("Sentry private payload filtering", () => {
  it("removes private span payload attributes", () => {
    const span = {
      attributes: {
        "app.conversation.privacy": "private",
        "gen_ai.input.messages": messageAttribute("private prompt"),
        "gen_ai.output.messages": messageAttribute("private answer"),
        "gen_ai.system_instructions": JSON.stringify([
          { type: "text", content: "private system" },
        ]),
      },
      end_timestamp: 2,
      is_segment: false,
      name: "gen_ai.chat",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    runWithConversationPrivacy("private", () => scrubPrivateSentrySpan(span));

    expect(span.attributes?.["gen_ai.input.messages"]).toBeUndefined();
    expect(span.attributes?.["gen_ai.output.messages"]).toBeUndefined();
    expect(span.attributes?.["gen_ai.system_instructions"]).toBeUndefined();
    expect(span.attributes?.["app.conversation.payload_redacted"]).toBe(true);
  });

  it("preserves public channel payloads", () => {
    const payload = messageAttribute("public prompt");
    const span = {
      attributes: {
        "gen_ai.input.messages": payload,
      },
      end_timestamp: 2,
      is_segment: false,
      name: "gen_ai.chat",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    runWithConversationPrivacy("public", () => scrubPrivateSentrySpan(span));

    expect(span.attributes?.["gen_ai.input.messages"]).toBe(payload);
    expect(
      span.attributes?.["app.conversation.payload_redacted"],
    ).toBeUndefined();
  });

  it("fails closed for payload attributes without conversation privacy", () => {
    const log = {
      level: "info",
      message: "ai_call",
      attributes: {
        "gen_ai.tool.call.arguments": JSON.stringify({
          query: "private search",
        }),
      },
    } as SentryLog;

    scrubPrivateSentryLog(log);

    expect(log.attributes?.["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(log.attributes?.["app.conversation.payload_redacted"]).toBe(true);
  });

  it("uses the current conversation privacy for transaction child spans", () => {
    const payload = messageAttribute("public answer");
    const transaction = {
      type: "transaction",
      spans: [
        {
          data: {
            "gen_ai.output.messages": payload,
          },
          span_id: "child",
          start_timestamp: 1,
          trace_id: "trace",
        },
      ],
    } as SentryTransaction;

    runWithConversationPrivacy("public", () =>
      scrubPrivateSentryTransaction(transaction),
    );

    expect(transaction.spans?.[0]?.data["gen_ai.output.messages"]).toBe(
      payload,
    );
  });
});
