import { httpHeadersToSpanAttributes } from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JUNIOR_VERSION } from "@/version";
import { runWithConversationPrivacy } from "@/chat/conversation-privacy";

const ORIGINAL_SENTRY_DSN = process.env.SENTRY_DSN;
const ORIGINAL_SENTRY_RELEASE = process.env.SENTRY_RELEASE;
const ORIGINAL_VERCEL_DEPLOYMENT_ID = process.env.VERCEL_DEPLOYMENT_ID;
const ORIGINAL_VERCEL_GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA;
const ORIGINAL_VERCEL_REGION = process.env.VERCEL_REGION;

function resetEnv(): void {
  if (ORIGINAL_SENTRY_DSN === undefined) {
    delete process.env.SENTRY_DSN;
  } else {
    process.env.SENTRY_DSN = ORIGINAL_SENTRY_DSN;
  }
  if (ORIGINAL_SENTRY_RELEASE === undefined) {
    delete process.env.SENTRY_RELEASE;
  } else {
    process.env.SENTRY_RELEASE = ORIGINAL_SENTRY_RELEASE;
  }
  if (ORIGINAL_VERCEL_DEPLOYMENT_ID === undefined) {
    delete process.env.VERCEL_DEPLOYMENT_ID;
  } else {
    process.env.VERCEL_DEPLOYMENT_ID = ORIGINAL_VERCEL_DEPLOYMENT_ID;
  }
  if (ORIGINAL_VERCEL_GIT_COMMIT_SHA === undefined) {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
  } else {
    process.env.VERCEL_GIT_COMMIT_SHA = ORIGINAL_VERCEL_GIT_COMMIT_SHA;
  }
  if (ORIGINAL_VERCEL_REGION === undefined) {
    delete process.env.VERCEL_REGION;
  } else {
    process.env.VERCEL_REGION = ORIGINAL_VERCEL_REGION;
  }
}

async function loadInstrumentationModule() {
  vi.resetModules();
  const init = vi.fn();
  const globalScope = { setAttributes: vi.fn() };
  vi.doMock("@/chat/sentry", () => ({
    getClient: () => undefined,
    init,
    getGlobalScope: () => globalScope,
  }));
  const instrumentation = await import("@/instrumentation");
  return { init, globalScope, instrumentation };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/chat/sentry");
  resetEnv();
});

describe("initSentry", () => {
  it("adds deployment metadata to the global scope", async () => {
    process.env.SENTRY_DSN = "https://public@example.com/1";
    process.env.SENTRY_RELEASE = " ";
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_123";
    process.env.VERCEL_GIT_COMMIT_SHA = "git-sha";
    process.env.VERCEL_REGION = "iad1";

    const { init, globalScope, instrumentation } =
      await loadInstrumentationModule();
    instrumentation.initSentry();

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0];
    expect(options?.release).toBe(`${JUNIOR_VERSION}+git-sha`);
    const dataCollection = options?.dataCollection;
    expect(dataCollection).toMatchObject({
      httpBodies: [],
      databaseQueryData: false,
      urlQueryParams: false,
    });
    const headerAttributes = httpHeadersToSpanAttributes(
      {
        forwarded: "for=1.2.3.4;sig=secret",
        "user-agent": "git/2.47",
        "vercel-forwarded-path": "/api/search?query=secret",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=secret",
        "x-slack-signature": "v0=secret",
      },
      // The SDK applies resolved options; header filtering reads only these.
      {
        cookies: true,
        httpHeaders: { response: true, ...(dataCollection?.httpHeaders as {}) },
      } as never,
    );
    expect(JSON.stringify(headerAttributes)).not.toContain("secret");
    expect(headerAttributes).toMatchObject({
      "http.request.header.user-agent": ["git/2.47"],
      "http.request.header.x-github-event": ["push"],
    });
    expect(options?.beforeSend).toEqual(expect.any(Function));
    expect(options?.beforeSendLog).toEqual(expect.any(Function));
    expect(options?.beforeSendSpan).toEqual(expect.any(Function));
    const http = { name: "Http", setupOnce: () => {} };
    expect(
      options?.integrations?.([
        http,
        { name: "Anthropic_AI", setupOnce: () => {} },
        { name: "Dedupe", setupOnce: () => {} },
        { name: "VercelAI", setupOnce: () => {} },
      ]),
    ).toEqual([http]);
    const span: {
      attributes: Record<string, unknown>;
      end_timestamp: number;
      is_segment: boolean;
      name: string;
      span_id: string;
      start_timestamp: number;
      status: "ok";
      trace_id: string;
    } = {
      attributes: {
        "gen_ai.input.messages": "private input",
      },
      end_timestamp: 2,
      is_segment: false,
      name: "gen_ai.chat",
      span_id: "span",
      start_timestamp: 1,
      status: "ok",
      trace_id: "trace",
    };
    runWithConversationPrivacy("private", () =>
      options?.beforeSendSpan?.(span),
    );
    expect(span.attributes["gen_ai.input.messages"]).toBeUndefined();
    expect(span.attributes["app.conversation.payload_redacted"]).toBe(true);

    expect(globalScope.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "app.junior.version": JUNIOR_VERSION,
        "deployment.id": "dpl_123",
        "service.version": `${JUNIOR_VERSION}+git-sha`,
        "service.instance.id": expect.any(String),
        "cloud.region": "iad1",
      }),
    );
  });
});
