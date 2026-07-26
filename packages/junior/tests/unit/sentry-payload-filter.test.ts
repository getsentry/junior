import { describe, expect, it } from "vitest";
import { runWithConversationPrivacy } from "@/chat/conversation-privacy";
import { privateTraceResultAttributes } from "@/chat/tool-support/private-trace-result";
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
  it("removes OAuth query secrets from URL attributes", () => {
    const span = {
      attributes: {
        "http.target":
          "/api/oauth/callback/github?code=secret&state=signed-state",
        "url.full":
          "http://127.0.0.1/api/oauth/callback/github?code=secret&state=signed-state",
        "url.query": "code=secret&state=signed-state",
      },
      end_timestamp: 2,
      is_segment: false,
      name: "http.server",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    scrubPrivateSentrySpan(span);

    expect(span.attributes?.["http.target"]).toBe("/api/oauth/callback/github");
    expect(span.attributes?.["url.full"]).toBe(
      "http://127.0.0.1/api/oauth/callback/github",
    );
    expect(span.attributes?.["url.query"]).toBeUndefined();
  });

  it("removes OAuth secrets from captured request data", () => {
    const event = {
      type: "transaction",
      request: {
        data: "credential-body",
        headers: {
          "X-Junior-Local-Credential-Signature": "signature",
          "x-junior-sandbox-egress-token": "token",
        },
        query_string: "code=secret&state=signed-state",
        url: "https://junior.example/api/oauth/callback/github?code=secret&state=signed-state",
      },
    } as SentryTransaction;

    scrubPrivateSentryTransaction(event);

    expect(event.request?.url).toBe(
      "https://junior.example/api/oauth/callback/github",
    );
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.headers).toEqual({});
  });

  it("removes local credential bodies and normalized secret header spans", () => {
    const event = {
      type: "transaction",
      request: {
        data: '{"tokens":{"accessToken":"secret"}}',
        headers: {
          "x-junior-local-credential-signature": "signature",
        },
        url: "http://127.0.0.1/api/internal/local-oauth-credentials",
      },
    } as SentryTransaction;
    const span = {
      attributes: {
        "http.request.body.data": '{"tokens":{"accessToken":"span-secret"}}',
        "http.request.header.x_junior_sandbox_egress_token": "token",
        "url.path": "/api/internal/local-oauth-credentials",
      },
      end_timestamp: 2,
      is_segment: false,
      name: "http.client",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    scrubPrivateSentryTransaction(event);
    scrubPrivateSentrySpan(span);

    expect(event.request?.data).toBeUndefined();
    expect(event.request?.headers).toEqual({});
    expect(span.attributes).toEqual({
      "url.path": "/api/internal/local-oauth-credentials",
    });
  });

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

  it("preserves explicitly projected private tool results", () => {
    const projectedResult = JSON.stringify({ tools: ["safeTool"] });
    const span = {
      attributes: {
        "gen_ai.tool.call.arguments": JSON.stringify({
          query: "private search",
        }),
        "gen_ai.tool.call.result": projectedResult,
        ...privateTraceResultAttributes(),
      },
      end_timestamp: 2,
      is_segment: false,
      name: "execute_tool searchTools",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    runWithConversationPrivacy("private", () => scrubPrivateSentrySpan(span));

    expect(span.attributes?.["gen_ai.tool.call.arguments"]).toBeUndefined();
    expect(span.attributes?.["gen_ai.tool.call.result"]).toBe(projectedResult);
    expect(span.attributes?.["app.conversation.payload_redacted"]).toBe(true);
    expect(span.attributes).not.toHaveProperty(
      "gen_ai.tool.call.result.exposure",
    );
  });

  it("redacts private results with a forged projection marker", () => {
    const span = {
      attributes: {
        "gen_ai.tool.call.result": JSON.stringify({ secret: "private" }),
        "gen_ai.tool.call.result.exposure": "projected",
      },
      end_timestamp: 2,
      is_segment: false,
      name: "execute_tool unsafeTool",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    runWithConversationPrivacy("private", () => scrubPrivateSentrySpan(span));

    expect(span.attributes?.["gen_ai.tool.call.result"]).toBeUndefined();
    expect(span.attributes).not.toHaveProperty(
      "gen_ai.tool.call.result.exposure",
    );
  });

  it("redacts unmarked private tool results", () => {
    const span = {
      attributes: {
        "gen_ai.tool.call.result": JSON.stringify({ secret: "private" }),
      },
      end_timestamp: 2,
      is_segment: false,
      name: "execute_tool unsafeTool",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;

    runWithConversationPrivacy("private", () => scrubPrivateSentrySpan(span));

    expect(span.attributes?.["gen_ai.tool.call.result"]).toBeUndefined();
    expect(span.attributes?.["app.conversation.payload_redacted"]).toBe(true);
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
