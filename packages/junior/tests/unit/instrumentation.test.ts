import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithConversationPrivacy } from "@/chat/conversation-privacy";

const ORIGINAL_SENTRY_DSN = process.env.SENTRY_DSN;
const ORIGINAL_SENTRY_RELEASE = process.env.SENTRY_RELEASE;
const ORIGINAL_VERCEL_DEPLOYMENT_ID = process.env.VERCEL_DEPLOYMENT_ID;
const ORIGINAL_VERCEL_GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA;

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
}

async function loadInstrumentationModule() {
  vi.resetModules();
  const init = vi.fn();
  const globalScope = { setAttributes: vi.fn() };
  vi.doMock("@/chat/sentry", () => ({
    getClient: () => undefined,
    init,
    getGlobalScope: () => globalScope,
    vercelAIIntegration: vi.fn((options) => ({
      name: "vercel-ai",
      options,
    })),
    withStreamedSpan: vi.fn((callback) =>
      Object.assign(callback, { _streamed: true }),
    ),
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

    const { init, globalScope, instrumentation } =
      await loadInstrumentationModule();
    instrumentation.initSentry();

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0];
    expect(options?.release).toBe("git-sha");
    expect(options).toMatchObject({
      sendDefaultPii: true,
      streamGenAiSpans: true,
    });
    expect(options?.beforeSend).toEqual(expect.any(Function));
    expect(options?.beforeSendLog).toEqual(expect.any(Function));
    expect(options?.beforeSendSpan).toEqual(expect.any(Function));
    expect(options?.beforeSendSpan?._streamed).toBe(true);
    expect(options?.beforeSendTransaction).toEqual(expect.any(Function));
    expect(options?.integrations?.[0]).toMatchObject({
      options: {
        recordInputs: true,
        recordOutputs: true,
      },
    });
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
        "deployment.id": "dpl_123",
        "service.version": "git-sha",
      }),
    );
  });
});
