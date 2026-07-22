import { expect } from "vitest";
import { toolCalls } from "vitest-evals";

export const REMINDER_ONLY_FORBIDDEN_TOOLS = [
  "webSearch",
  "webFetch",
  "bash",
  "readFile",
  "editFile",
  "grep",
  "findFiles",
  "listDir",
  "writeFile",
  "callMcpTool",
  "slackThreadRead",
  "slackChannelListMessages",
] as const;

export function scheduledTaskCreateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "scheduler_slackScheduleCreateTask" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function scheduledTaskUpdateCalls(
  session: Parameters<typeof toolCalls>[0],
) {
  return toolCalls(session).filter(
    (call) =>
      call.name === "scheduler_slackScheduleUpdateTask" &&
      call.status === "ok" &&
      call.result !== undefined,
  );
}

export function expectNoToolCalls(
  session: Parameters<typeof toolCalls>[0],
  names: readonly string[],
) {
  expect(
    toolCalls(session)
      .map((call) => call.name)
      .filter((name) => names.includes(name)),
  ).toEqual([]);
}
