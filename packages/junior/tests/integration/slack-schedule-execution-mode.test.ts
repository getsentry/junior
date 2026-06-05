import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupSlackScheduleToolTest,
  createContext,
  createSlackScheduleCreateTaskTool,
  createSlackScheduleDeleteTaskTool,
  createSlackScheduleListTasksTool,
  createSlackScheduleRunTaskNowTool,
  createSlackScheduleUpdateTaskTool,
  setupSlackScheduleToolTest,
} from "../fixtures/slack-schedule-tools";

describe("Slack schedule tool execution modes", () => {
  beforeEach(setupSlackScheduleToolTest);
  afterEach(cleanupSlackScheduleToolTest);

  it("all write tools have executionMode sequential", () => {
    const context = createContext();

    const createTool = createSlackScheduleCreateTaskTool(context);
    const listTool = createSlackScheduleListTasksTool(context);
    const updateTool = createSlackScheduleUpdateTaskTool(context);
    const deleteTool = createSlackScheduleDeleteTaskTool(context);
    const runNowTool = createSlackScheduleRunTaskNowTool(context);

    // Write tools must force sequential execution so a same-turn
    // slackScheduleListTasks call cannot race ahead of a preceding
    // slackScheduleCreateTask / update / delete write.
    expect(createTool.executionMode).toBe("sequential");
    expect(updateTool.executionMode).toBe("sequential");
    expect(deleteTool.executionMode).toBe("sequential");
    expect(runNowTool.executionMode).toBe("sequential");

    // List is read-only; it inherits the sequential batch gate from any
    // write tool it shares a turn with (pi-agent-core makes the whole
    // batch sequential when any tool in it is sequential).
    expect(listTool.executionMode).not.toBe("sequential");
  });
});
