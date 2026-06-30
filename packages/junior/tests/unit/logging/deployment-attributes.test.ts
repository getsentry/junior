import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmittedLogRecord } from "@/chat/logging";

const ORIGINAL_SENTRY_RELEASE = process.env.SENTRY_RELEASE;
const ORIGINAL_VERCEL_DEPLOYMENT_ID = process.env.VERCEL_DEPLOYMENT_ID;
const ORIGINAL_VERCEL_GIT_COMMIT_SHA = process.env.VERCEL_GIT_COMMIT_SHA;

async function loadLoggingModule() {
  vi.resetModules();
  vi.doMock("@/chat/sentry", () => ({
    captureException: undefined,
    captureMessage: undefined,
    getActiveSpan: () => undefined,
    logger: {},
    setTag: undefined,
    setUser: undefined,
    spanToJSON: () => ({}),
    withScope: undefined,
  }));
  return await import("@/chat/logging");
}

function resetEnv(): void {
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("@/chat/sentry");
  resetEnv();
});

describe("deployment log attributes", () => {
  it("adds deployment metadata to emitted log records", async () => {
    process.env.SENTRY_RELEASE = " ";
    process.env.VERCEL_DEPLOYMENT_ID = "dpl_123";
    process.env.VERCEL_GIT_COMMIT_SHA = "git-sha";

    const { log, registerLogRecordSink } = await loadLoggingModule();
    const records: EmittedLogRecord[] = [];
    const unregister = registerLogRecordSink((record) => {
      records.push(record);
    });

    try {
      log.warn(
        "deployment_context_test",
        {
          "deployment.id": "caller-deployment",
          "service.version": "caller-version",
        },
        "Deployment context test",
      );
    } finally {
      unregister();
    }

    expect(records).toHaveLength(1);
    expect(records[0]?.attributes).toMatchObject({
      "deployment.id": "dpl_123",
      "service.version": "git-sha",
    });
  });
});
