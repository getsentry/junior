import { describe, expect, it } from "vitest";
import { runWithConversationPrivacy } from "@/chat/conversation-privacy";
import { privateTraceResultAttributes } from "@/chat/tool-support/private-trace-result";
import {
  scrubPrivateSentryEvent,
  scrubPrivateSentryLog,
  scrubPrivateSentrySpan,
} from "@/chat/sentry-payload-filter";

type SentrySpan = Parameters<typeof scrubPrivateSentrySpan>[0];
type SentryLog = Parameters<typeof scrubPrivateSentryLog>[0];
type SentryEvent = Parameters<typeof scrubPrivateSentryEvent>[0];

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

  it("keeps only the host of private Slack file URLs", () => {
    const fileUrl =
      "https://files.slack.com/files-pri/T123-F456/private-plan.pdf";
    const span = {
      attributes: {
        "server.address": "files.slack.com",
        "url.full": `${fileUrl}?pub_secret=abc`,
        "url.path": "/files-pri/T123-F456/private-plan.pdf",
        "url.query": "pub_secret=abc",
      },
      end_timestamp: 2,
      is_segment: false,
      name: "GET files.slack.com",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;
    const event = {
      type: undefined,
      breadcrumbs: [
        {
          category: "http",
          data: { url: fileUrl, "url.query": "pub_secret=abc" },
        },
      ],
    } as SentryEvent;

    scrubPrivateSentrySpan(span);
    scrubPrivateSentryEvent(event);

    expect(span.attributes).toEqual({
      "server.address": "files.slack.com",
      "url.full": "https://files.slack.com",
    });
    expect(event.breadcrumbs?.[0]?.data).toEqual({
      url: "https://files.slack.com",
    });
  });

  it("removes OAuth secrets from captured request data", () => {
    const event = {
      type: undefined,
      request: {
        data: "credential-body",
        headers: {
          "X-Junior-Local-Credential-Signature": "signature",
          "x-junior-sandbox-egress-token": "token",
        },
        query_string: "code=secret&state=signed-state",
        url: "https://junior.example/api/oauth/callback/github?code=secret&state=signed-state",
      },
    } as SentryEvent;

    scrubPrivateSentryEvent(event);

    expect(event.request?.url).toBe(
      "https://junior.example/api/oauth/callback/github",
    );
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.headers).toEqual({});
  });

  it("removes local credential bodies and normalized secret header spans", () => {
    const event = {
      type: undefined,
      request: {
        data: '{"tokens":{"accessToken":"secret"}}',
        headers: {
          "x-junior-local-credential-signature": "signature",
        },
        url: "http://127.0.0.1/api/internal/local-oauth-credentials",
      },
    } as SentryEvent;
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

    scrubPrivateSentryEvent(event);
    scrubPrivateSentrySpan(span);

    expect(event.request?.data).toBeUndefined();
    expect(event.request?.headers).toEqual({});
    expect(span.attributes).toEqual({
      "url.path": "/api/internal/local-oauth-credentials",
    });
  });

  it("hides sandbox egress tokens, query strings, and credential headers", () => {
    const proxyPath =
      "/api/internal/sandbox-egress/v1.context.signature/graphql";
    const span = {
      attributes: {
        "http.request.body.data": '{"query":"secret","variables":{"q":"x"}}',
        "http.request.header.forwarded": ["for=1.2.3.4;sig=secret"],
        "http.request.header.user-agent": ["git/2.47"],
        "http.request.header.vercel-forwarded-path": ["/graphql?q=secret"],
        "http.request.header.x-hub-signature-256": ["sha256=secret"],
        "http.target": `${proxyPath}?query=trace:abc`,
        "sentry.segment.name": `POST /junior${proxyPath}?q=secret`,
        "url.full": `https://junior.example${proxyPath}?query=trace:abc#frag`,
        "url.path": proxyPath,
      },
      end_timestamp: 2,
      is_segment: true,
      name: `POST https://junior.example${proxyPath}?query=trace:abc`,
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    } as SentrySpan;
    const querySpan = {
      ...span,
      attributes: { "url.path": "/api/internal/sandbox-egress/signals" },
      name: "select * from events where id = ?",
    } as SentrySpan;
    const event = {
      type: undefined,
      transaction: `GET ${proxyPath}`,
      request: {
        data: "body",
        headers: {
          Forwarded: "for=1.2.3.4;sig=secret",
          "User-Agent": "git/2.47",
          "Vercel-Forwarded-Path": "/graphql?q=secret",
          "X-Slack-Signature": "v0=secret",
        },
        query_string: "q=search",
        url: "https://junior.example/api/conversations?q=search",
      },
    } as SentryEvent;

    scrubPrivateSentrySpan(span);
    scrubPrivateSentrySpan(querySpan);
    scrubPrivateSentryEvent(event);

    const redactedPath = "/api/internal/sandbox-egress/<token>";
    expect(span.name).toBe(`POST https://junior.example${redactedPath}`);
    expect(span.attributes).toEqual({
      "http.request.header.user-agent": ["git/2.47"],
      "http.target": redactedPath,
      "sentry.segment.name": `POST /junior${redactedPath}`,
      "url.full": `https://junior.example${redactedPath}`,
      "url.path": redactedPath,
    });
    expect(querySpan.name).toBe("select * from events where id = ?");
    expect(querySpan.attributes?.["url.path"]).toBe(
      "/api/internal/sandbox-egress/signals",
    );
    expect(event.transaction).toBe(`GET ${redactedPath}`);
    expect(event.request).toEqual({
      headers: { "User-Agent": "git/2.47" },
      url: "https://junior.example/api/conversations",
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
});
