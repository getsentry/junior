import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  disconnectStateAdapter,
  getStateAdapter,
  getStateValues,
  setStateValues,
} from "@/chat/state/adapter";

// Chat config reads the state adapter when it loads, so set it first. CI
// runs Redis at REDIS_URL. Locally, compose.yaml runs it on port 6382.
vi.hoisted(() => {
  process.env["JUNIOR_STATE_ADAPTER"] = "redis";
  process.env["REDIS_URL"] =
    process.env["REDIS_URL"]?.trim() || "redis://localhost:6382";
  process.env["JUNIOR_STATE_KEY_PREFIX"] = `junior_test_${crypto.randomUUID()}`;
});

afterAll(async () => {
  await disconnectStateAdapter();
});

describe("batched Redis state values", () => {
  it("uses the same keys and values as single reads and writes", async () => {
    const state = getStateAdapter();
    const written = `written-${randomUUID()}`;
    const batched = `batched-${randomUUID()}`;
    await state.set(written, { seq: 1 }, 60_000);

    await expect(
      getStateValues(state, [written, `missing-${randomUUID()}`]),
    ).resolves.toEqual([{ seq: 1 }, null]);

    await setStateValues(state, [{ key: batched, value: { seq: 2 } }], 60_000);
    await expect(state.get(batched)).resolves.toEqual({ seq: 2 });
  });
});
