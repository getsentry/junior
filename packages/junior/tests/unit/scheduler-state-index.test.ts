import { describe, expect, it } from "vitest";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createSchedulerStore } from "../../../junior-scheduler/src/store";
import { createPluginState } from "@/chat/plugins/state";

describe("scheduler plugin-state indexes", () => {
  it("rejects a malformed persisted task index", async () => {
    const stateAdapter = createMemoryState();
    const state = createPluginState("scheduler", stateAdapter);
    await state.set("junior:scheduler:tasks", { invalid: true });
    const store = createSchedulerStore(state);

    try {
      await expect(store.listTasks()).rejects.toThrow("expected array");
    } finally {
      await stateAdapter.disconnect();
    }
  });
});
