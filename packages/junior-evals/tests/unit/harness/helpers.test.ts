import { expect, it, vi } from "vitest";

const { runError, runEvalScenarioMock } = vi.hoisted(() => ({
  runError: new Error("stop after capturing harness options"),
  runEvalScenarioMock: vi.fn(async () => {
    throw new Error("uninitialized run error");
  }),
}));

vi.mock("../../../src/behavior-harness", () => ({
  runEvalScenario: runEvalScenarioMock,
}));

import { slackHarness } from "../../../src/helpers";

it("forwards the Vitest abort signal to the eval scenario", async () => {
  runEvalScenarioMock.mockRejectedValueOnce(runError);
  const controller = new AbortController();

  await expect(
    slackHarness.run(
      { criteria: { pass: [] }, initialEvents: [] },
      {
        artifacts: {},
        setArtifact: vi.fn(),
        signal: controller.signal,
      },
    ),
  ).rejects.toBe(runError);

  expect(runEvalScenarioMock).toHaveBeenCalledWith(
    { initialEvents: [], events: undefined, overrides: undefined },
    { logRecords: [], signal: controller.signal },
  );
});
