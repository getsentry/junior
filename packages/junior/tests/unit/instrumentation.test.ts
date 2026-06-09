import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.doMock("@/chat/sentry", () => ({
    getClient: () => undefined,
    init,
    vercelAIIntegration: () => ({ name: "vercel-ai" }),
  }));
  const instrumentation = await import("@/instrumentation");
  return { init, instrumentation };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/chat/sentry");
  resetEnv();
});

describe("initSentry", () => {
  it("adds deployment metadata to outgoing spans", async () => {
    process.env.SENTRY_DSN = "https://public@example.com/1";
    process.env.SENTRY_RELEASE = " ";
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_123";
    process.env.VERCEL_GIT_COMMIT_SHA = "git-sha";

    const { init, instrumentation } = await loadInstrumentationModule();
    instrumentation.initSentry();

    expect(init).toHaveBeenCalledTimes(1);
    const options = init.mock.calls[0]?.[0];
    expect(options?.release).toBe("git-sha");
    expect(options?.beforeSendSpan).toBeTypeOf("function");

    const span = {
      data: {
        "deployment.id": "span-deployment",
        "service.version": "span-version",
      },
    };

    expect(options.beforeSendSpan(span)).toBe(span);
    expect(span.data).toMatchObject({
      "deployment.id": "dpl_123",
      "service.version": "git-sha",
    });
  });
});
