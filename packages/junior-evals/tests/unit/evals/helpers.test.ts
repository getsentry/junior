import { afterEach, describe, expect, it, vi } from "vitest";

describe("slackEval", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.doUnmock("vitest-evals/evaluate");
    vi.doUnmock("@ai-sdk/gateway");
    vi.doUnmock("@/chat/logging");
    vi.doUnmock("../../../evals/behavior-harness");
  });

  it("unregisters the log sink when task timeout wins the race", async () => {
    const configureMock = vi.fn();
    const evaluateMock = vi.fn();
    const gatewayMock = vi.fn(() => "gateway-model");
    const unregisterLogSinkMock = vi.fn();
    const registerLogRecordSinkMock = vi.fn(() => unregisterLogSinkMock);
    const runEvalScenarioMock = vi.fn(() => new Promise(() => {}));

    vi.doMock("vitest-evals/evaluate", () => ({
      configure: configureMock,
      evaluate: evaluateMock,
    }));
    vi.doMock("@ai-sdk/gateway", () => ({
      gateway: gatewayMock,
    }));
    vi.doMock("@/chat/logging", () => ({
      registerLogRecordSink: registerLogRecordSinkMock,
    }));
    vi.doMock("../../../evals/behavior-harness", () => ({
      runEvalScenario: runEvalScenarioMock,
    }));

    const { slackEval } = await import("../../../evals/helpers");

    slackEval("timeout cleanup", {
      events: [],
      criteria: "unused",
      taskTimeout: 1,
    });

    const config = evaluateMock.mock.calls[0]?.[1] as
      | { task: () => Promise<string> }
      | undefined;
    expect(config).toBeDefined();

    await expect(config?.task()).rejects.toThrow(
      "Eval harness timed out after 1ms before judge evaluation",
    );
    expect(unregisterLogSinkMock).toHaveBeenCalledTimes(1);
  });
});
